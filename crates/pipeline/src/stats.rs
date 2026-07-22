// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

//! Native stats collection for the pipeline WASM module.
//!
//! Wraps `SpanConcentrator` from `libdd-trace-stats` and provides encoding +
//! HTTP transport for flushing stats to the Datadog agent's `/v0.6/stats`
//! endpoint.

use std::time::Duration;
use web_time::SystemTime;

/// Wall-clock now() for wasm. `std::time::SystemTime::now()` is unimplemented on
/// `wasm32-unknown-unknown` (it panics/traps), so derive the time from JS
/// `Date.now()` (milliseconds since the Unix epoch).
fn now() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(js_sys::Date::now() as u64)
}

use bytes::Bytes;
use libdatadog_nodejs_capabilities::WasmHttpClient;
use libdd_capabilities::http::HttpClientCapability;
use libdd_common::parse_uri;
use libdd_trace_protobuf::pb;
use libdd_trace_stats::span_concentrator::SpanConcentrator;

use crate::trace_data::WasmTraceData;

const STATS_ENDPOINT_PATH: &str = "/v0.6/stats";

/// Metadata for the stats payload envelope.
pub struct StatsMeta {
    pub hostname: String,
    pub env: String,
    pub version: String,
    pub lang: String,
    pub tracer_version: String,
    pub runtime_id: String,
    pub service: String,
}

/// Stats data prepared by a synchronous concentrator flush.
pub struct PreparedStatsFlush {
    pub request: Option<http::Request<Bytes>>,
    pub collapsed_spans: u64,
}

/// Manages stats aggregation and flushing.
pub struct StatsCollector {
    concentrator: SpanConcentrator,
    meta: StatsMeta,
    agent_url: String,
    sequence: u64,
}

impl StatsCollector {
    /// Create a new stats collector.
    pub fn new(bucket_size: Duration, agent_url: String, meta: StatsMeta) -> Self {
        StatsCollector {
            concentrator: SpanConcentrator::new(
                bucket_size,
                now(),
                vec![
                    "client".to_string(),
                    "server".to_string(),
                    "producer".to_string(),
                    "consumer".to_string(),
                ],
                Vec::new(),
                None,
                Vec::new(),
            ),
            meta,
            agent_url,
            sequence: 0,
        }
    }

    /// Add spans to the concentrator for stats aggregation.
    ///
    /// The spans should already have `_dd.top_level` and `_dd.measured` metrics
    /// set (done by `ChangeBufferState::flush_chunk`).
    pub fn add_spans(&mut self, spans: &[libdd_trace_utils::span::v04::Span<WasmTraceData>]) {
        for span in spans {
            self.concentrator.add_span(span);
        }
    }

    /// Drain aggregated stats into a ready-to-send request plus flush metadata,
    /// **synchronously**.
    ///
    /// Returns `request: None` when there is no stats payload to send. The
    /// concentrator is drained and the sequence advanced as part of this call,
    /// so a returned request must be sent (see `send_request`). Kept
    /// synchronous and separate from the send so a caller can build the request
    /// under a brief borrow and release the collector *before* the async send —
    /// leaving it available for `add_spans` while the stats request is in
    /// flight.
    pub fn prepare_request(&mut self, force: bool) -> Result<PreparedStatsFlush, String> {
        let mut flush = self.concentrator.flush(now(), force);
        let collapsed_spans = flush.collapsed_spans;
        if !flush.obfuscated_buckets.is_empty() {
            // TODO: stats obfuscation is currently disabled. Obfuscated stats
            // require the datadog-obfuscation-version header, which
            // prepare_request doesn't emit yet. Add that header before enabling
            // stats-obfuscation.
            return Err(
                "stats flush produced obfuscated buckets without obfuscation header support"
                    .to_string(),
            );
        }
        if flush.unobfuscated_buckets.is_empty() {
            return Ok(PreparedStatsFlush {
                request: None,
                collapsed_spans,
            });
        }

        self.sequence += 1;
        let buckets = std::mem::take(&mut flush.unobfuscated_buckets);
        let payload = encode_stats_payload(&buckets, &self.meta, self.sequence);

        let body = rmp_serde::encode::to_vec_named(&payload)
            .map_err(|e| format!("stats msgpack encode error: {e}"))?;

        // Build the base agent URI exactly like the trace exporter does, via
        // libdatadog's `parse_uri`. For a `unix://` / `windows:` agent URL that
        // hex-encodes the socket path into the URI *authority* (there is no
        // standard URL form for socket paths), which the WASM HTTP client's
        // `decode_socket_path` reverses to route over the socket. A raw parse
        // instead leaves the socket path in the URI *path* with an empty/invalid
        // authority, so the stats request never reaches the socket — client stats
        // silently never arrive over UDS (dd-trace-js #9139, uds-express4).
        let base = parse_uri(&self.agent_url).map_err(|e| format!("invalid agent URL: {e}"))?;
        // Append `/v0.6/stats` to the base path while preserving the (hex)
        // authority, mirroring libdd-data-pipeline's `add_path`. For `unix://`
        // the base path is "/" and the authority holds the hex socket path; for
        // TCP it's `http://host:port/`. Trim a trailing slash so the path is
        // exactly `/v0.6/stats` (a double slash makes the agent miss the request).
        let base_path = base.path().strip_suffix('/').unwrap_or_else(|| base.path());
        let new_path_and_query = format!("{base_path}{STATS_ENDPOINT_PATH}");
        let mut parts = base.into_parts();
        parts.path_and_query = Some(
            new_path_and_query
                .parse()
                .map_err(|e| format!("invalid stats path: {e}"))?,
        );
        let uri = http::Uri::from_parts(parts).map_err(|e| format!("invalid stats URL: {e}"))?;

        let req = http::Request::builder()
            .method(http::Method::PUT)
            .uri(uri)
            .header("Content-Type", "application/msgpack")
            .header("Datadog-Meta-Lang", &self.meta.lang)
            .header("Datadog-Meta-Tracer-Version", &self.meta.tracer_version)
            .body(Bytes::from(body))
            .map_err(|e| format!("failed to build stats request: {e}"))?;

        Ok(PreparedStatsFlush {
            request: Some(req),
            collapsed_spans,
        })
    }

    /// Send a prepared stats request to the agent. Does **not** borrow the
    /// collector, so trace export (`add_spans`) can proceed during the await.
    pub async fn send_request(req: http::Request<Bytes>) -> Result<(), String> {
        let client = WasmHttpClient::new_client();
        client
            .request(req)
            .await
            .map_err(|e| format!("stats send error: {e:?}"))?;
        Ok(())
    }
}

/// Encode flushed stats buckets into a `ClientStatsPayload` for msgpack
/// serialization.
fn encode_stats_payload(
    buckets: &[pb::ClientStatsBucket],
    meta: &StatsMeta,
    sequence: u64,
) -> pb::ClientStatsPayload {
    pb::ClientStatsPayload {
        hostname: meta.hostname.clone(),
        env: meta.env.clone(),
        version: meta.version.clone(),
        lang: meta.lang.clone(),
        tracer_version: meta.tracer_version.clone(),
        runtime_id: meta.runtime_id.clone(),
        sequence,
        stats: buckets.to_vec(),
        service: meta.service.clone(),
        container_id: String::new(),
        tags: Vec::new(),
        agent_aggregation: String::new(),
        git_commit_sha: String::new(),
        image_tag: String::new(),
        process_tags: String::new(),
        process_tags_hash: 0,
    }
}
