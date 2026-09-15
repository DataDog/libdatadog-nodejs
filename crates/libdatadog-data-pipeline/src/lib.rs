// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

use std::io::Cursor;

use http::HeaderMap;
use libdd_capabilities::{HttpClientCapability, SleepCapability};
use libdd_common::Endpoint;
use libdd_trace_obfuscation::obfuscate::obfuscate_resource_for_stats;
use libdd_trace_obfuscation::sql::SqlObfuscationMode;
use libdd_trace_utils::send_with_retry::{
    send_with_retry, CompressionStrategy, RetryBackoffType, RetryStrategy, SendWithRetryError,
};
use libdd_trace_utils::stats_payload_encoder::MAX_GROUPED_STATS_PER_PAYLOAD;
use rmpv::Value;
use thiserror::Error;

pub use libdd_data_pipeline_core::{
    AgentlessTraceConfig, TracerMetadata, DEFAULT_AGENTLESS_TIMEOUT,
};
pub use libdd_trace_obfuscation::obfuscation_config::ObfuscationConfig;

#[derive(Debug, Error)]
pub enum SendAgentlessV04Error {
    #[error("failed to decode v0.4 traces: {0}")]
    Deserialization(libdd_trace_utils::msgpack_decoder::decode::error::DecodeError),
    #[error(transparent)]
    Agentless(#[from] libdd_data_pipeline_core::AgentlessError),
}

#[derive(Debug, Error)]
pub enum SendAgentlessStatsError {
    #[error("failed to decode client stats: {0}")]
    Deserialization(#[from] rmpv::decode::Error),
    #[error("failed to encode agentless stats: {0}")]
    Serialization(#[from] rmpv::encode::Error),
    #[error("invalid client stats payload: {0}")]
    InvalidPayload(&'static str),
    #[error("invalid agentless stats endpoint URL: {0}")]
    InvalidEndpoint(String),
    #[error("failed to send agentless stats: {0}")]
    Send(#[source] Box<SendWithRetryError>),
}

const AGENTLESS_STATS_MAX_RETRIES: u32 = 2;
const AGENTLESS_STATS_RETRY_DELAY_MS: u64 = 1000;

pub async fn send_agentless_v04<C>(
    capabilities: &C,
    payload: &[u8],
    metadata: &TracerMetadata,
    config: &AgentlessTraceConfig,
    client_side_stats: bool,
) -> Result<(), SendAgentlessV04Error>
where
    C: HttpClientCapability + SleepCapability,
{
    let (traces, _) = libdd_trace_utils::msgpack_decoder::v04::from_slice(payload)
        .map_err(SendAgentlessV04Error::Deserialization)?;
    libdd_data_pipeline_core::send_agentless_traces(
        capabilities,
        traces,
        metadata,
        config,
        client_side_stats,
    )
    .await?;
    Ok(())
}

pub async fn send_agentless_stats<C>(
    capabilities: &C,
    payload: &[u8],
    metadata: &TracerMetadata,
    config: &AgentlessTraceConfig,
    endpoint_url: &str,
) -> Result<(), SendAgentlessStatsError>
where
    C: HttpClientCapability + SleepCapability,
{
    let mut client_payload = decode_client_stats(payload)?;
    let client_map = value_map_mut(&mut client_payload)?;
    set_map_value(client_map, "Lang", metadata.language.clone().into());
    set_map_value(
        client_map,
        "TracerVersion",
        metadata.tracer_version.clone().into(),
    );
    set_map_value(
        client_map,
        "ContainerID",
        metadata.container_id.clone().into(),
    );
    let mut buckets = take_array(client_map, "Stats")?.unwrap_or_default();
    obfuscate_stats(&mut buckets, config.obfuscation_config.sql.obfuscation_mode)?;
    let groups = split_stats_buckets(buckets)?;
    if groups.is_empty() {
        return Ok(());
    }

    let url = libdd_common::parse_uri(endpoint_url)
        .map_err(|error| SendAgentlessStatsError::InvalidEndpoint(error.to_string()))?;
    let endpoint = Endpoint {
        url,
        api_key: Some(config.api_key.clone().into()),
        timeout_ms: u64::try_from(config.timeout.as_millis()).unwrap_or(u64::MAX),
        ..Endpoint::default()
    };
    let mut headers: HeaderMap = metadata.into();
    headers.insert(
        http::header::CONTENT_TYPE,
        libdd_common::header::APPLICATION_MSGPACK,
    );
    headers.insert(
        http::HeaderName::from_static("datadog-obfuscation-version"),
        http::HeaderValue::from_static("1"),
    );
    let retry = RetryStrategy::new(
        AGENTLESS_STATS_MAX_RETRIES,
        AGENTLESS_STATS_RETRY_DELAY_MS,
        RetryBackoffType::Exponential,
        None,
    );
    #[cfg(feature = "compression")]
    let compression = CompressionStrategy::Zstd { level: 1 };
    #[cfg(not(feature = "compression"))]
    let compression = CompressionStrategy::None;

    let split_payload = groups.len() > 1;
    let mut last_error = None;
    for stats in groups {
        let mut fragment = client_payload.clone();
        set_map_value(value_map_mut(&mut fragment)?, "Stats", stats.into());
        let payload = Value::Map(vec![
            ("AgentHostname".into(), metadata.hostname.clone().into()),
            ("AgentEnv".into(), metadata.env.clone().into()),
            ("Stats".into(), vec![fragment].into()),
            (
                "AgentVersion".into(),
                format!("{}-{}", metadata.tracer_version, metadata.language).into(),
            ),
            ("ClientComputed".into(), true.into()),
            ("SplitPayload".into(), split_payload.into()),
        ]);
        let mut body = Vec::new();
        rmpv::encode::write_value(&mut body, &payload)?;
        if let Err(error) =
            send_with_retry(capabilities, &endpoint, body, &headers, &retry, compression).await
        {
            last_error = Some(error);
        }
    }

    match last_error {
        Some(error) => Err(SendAgentlessStatsError::Send(Box::new(error))),
        None => Ok(()),
    }
}

fn decode_client_stats(payload: &[u8]) -> Result<Value, SendAgentlessStatsError> {
    let mut cursor = Cursor::new(payload);
    let value = rmpv::decode::read_value(&mut cursor)?;
    if cursor.position() != payload.len() as u64 {
        return Err(SendAgentlessStatsError::InvalidPayload(
            "trailing bytes after the MessagePack value",
        ));
    }
    if !matches!(value, Value::Map(_)) {
        return Err(SendAgentlessStatsError::InvalidPayload(
            "expected a MessagePack map",
        ));
    }
    Ok(value)
}

fn obfuscate_stats(
    buckets: &mut [Value],
    sql_obfuscation_mode: SqlObfuscationMode,
) -> Result<(), SendAgentlessStatsError> {
    for bucket in buckets {
        let mut stats = take_array(value_map_mut(bucket)?, "Stats")?.ok_or(
            SendAgentlessStatsError::InvalidPayload("stats bucket is missing Stats"),
        )?;
        for stats in &mut stats {
            let stats_map = value_map_mut(stats)?;
            let span_type = map_optional_string(stats_map, "Type")?.unwrap_or_default();
            let resource = map_string(stats_map, "Resource")?;
            let db_type = map_optional_string(stats_map, "DBType")?;
            if let Some(resource) =
                obfuscate_resource_for_stats(span_type, resource, db_type, sql_obfuscation_mode)
            {
                set_map_value(stats_map, "Resource", resource.into());
            }
        }
        set_map_value(value_map_mut(bucket)?, "Stats", stats.into());
    }
    Ok(())
}

fn split_stats_buckets(buckets: Vec<Value>) -> Result<Vec<Vec<Value>>, SendAgentlessStatsError> {
    let mut groups = Vec::new();
    let mut current = Vec::new();
    let mut current_count = 0;

    for mut bucket in buckets {
        let mut stats = take_array(value_map_mut(&mut bucket)?, "Stats")?.ok_or(
            SendAgentlessStatsError::InvalidPayload("stats bucket is missing Stats"),
        )?;
        while !stats.is_empty() {
            if current_count == MAX_GROUPED_STATS_PER_PAYLOAD {
                groups.push(std::mem::take(&mut current));
                current_count = 0;
            }
            let count = (MAX_GROUPED_STATS_PER_PAYLOAD - current_count).min(stats.len());
            let remaining = stats.split_off(count);
            let fragment_stats = std::mem::replace(&mut stats, remaining);
            let mut fragment = bucket.clone();
            set_map_value(
                value_map_mut(&mut fragment)?,
                "Stats",
                fragment_stats.into(),
            );
            current.push(fragment);
            current_count += count;
        }
    }

    if !current.is_empty() {
        groups.push(current);
    }
    Ok(groups)
}

fn value_map_mut(value: &mut Value) -> Result<&mut Vec<(Value, Value)>, SendAgentlessStatsError> {
    match value {
        Value::Map(map) => Ok(map),
        _ => Err(SendAgentlessStatsError::InvalidPayload(
            "expected a MessagePack map",
        )),
    }
}

fn map_value<'a>(map: &'a [(Value, Value)], name: &str) -> Option<&'a Value> {
    map.iter()
        .find(|(key, _)| key.as_str() == Some(name))
        .map(|(_, value)| value)
}

fn map_value_mut<'a>(map: &'a mut [(Value, Value)], name: &str) -> Option<&'a mut Value> {
    map.iter_mut()
        .find(|(key, _)| key.as_str() == Some(name))
        .map(|(_, value)| value)
}

fn map_string<'a>(
    map: &'a [(Value, Value)],
    name: &str,
) -> Result<&'a str, SendAgentlessStatsError> {
    map_value(map, name)
        .and_then(Value::as_str)
        .ok_or(SendAgentlessStatsError::InvalidPayload(
            "grouped stats contain a missing or invalid string field",
        ))
}

fn map_optional_string<'a>(
    map: &'a [(Value, Value)],
    name: &str,
) -> Result<Option<&'a str>, SendAgentlessStatsError> {
    match map_value(map, name) {
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or(SendAgentlessStatsError::InvalidPayload(
                "grouped stats contain an invalid optional string field",
            )),
        None => Ok(None),
    }
}

fn take_array(
    map: &mut [(Value, Value)],
    name: &str,
) -> Result<Option<Vec<Value>>, SendAgentlessStatsError> {
    let Some(value) = map_value_mut(map, name) else {
        return Ok(None);
    };
    match std::mem::replace(value, Value::Array(Vec::new())) {
        Value::Array(values) => Ok(Some(values)),
        _ => Err(SendAgentlessStatsError::InvalidPayload(
            "expected a MessagePack array",
        )),
    }
}

fn set_map_value(map: &mut Vec<(Value, Value)>, name: &str, value: Value) {
    if let Some(current) = map_value_mut(map, name) {
        *current = value;
    } else {
        map.push((name.into(), value));
    }
}
