// Copyright 2026-Present Datadog, Inc. https://www.datadoghq.com/
// SPDX-License-Identifier: Apache-2.0

use libdd_capabilities::{HttpClientCapability, SleepCapability};
use thiserror::Error;

pub use libdd_data_pipeline_core::{
    AgentlessTraceConfig, TracerMetadata, DEFAULT_AGENTLESS_TIMEOUT,
};

#[derive(Debug, Error)]
pub enum SendAgentlessV04Error {
    #[error("failed to decode v0.4 traces: {0}")]
    Deserialization(libdd_trace_utils::msgpack_decoder::decode::error::DecodeError),
    #[error(transparent)]
    Agentless(#[from] libdd_data_pipeline_core::AgentlessError),
}

pub async fn send_agentless_v04<C>(
    capabilities: &C,
    payload: &[u8],
    metadata: &TracerMetadata,
    config: &AgentlessTraceConfig,
) -> Result<(), SendAgentlessV04Error>
where
    C: HttpClientCapability + SleepCapability,
{
    let (traces, _) = libdd_trace_utils::msgpack_decoder::v04::from_slice(payload)
        .map_err(SendAgentlessV04Error::Deserialization)?;
    libdd_data_pipeline_core::send_agentless_traces(capabilities, traces, metadata, config).await?;
    Ok(())
}
