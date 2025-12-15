use napi_derive::napi;

use crate::utils::get_num_raw;

#[napi]
#[repr(u64)]
pub enum OpCode {
    Create = 0,
    SetMetaAttr = 1,
    SetMetricAttr = 2,
    SetServiceName = 3,
    SetResourceName = 4,
    SetError = 5,
    SetStart = 6,
    SetDuration = 7,
    SetType = 8,
    SetName = 9,
    SetTraceMetaAttr = 10,
    SetTraceMetricsAttr = 11,
    SetTraceOrigin = 12,
    // TODO: SpanLinks, SpanEvents, StructAttr
}

impl OpCode {
    pub(crate) fn from_num(num: u64) -> Self {
        unsafe { std::mem::transmute(num) }
    }
}

pub(crate) struct BufferedOperation {
    pub(crate) opcode: OpCode,
    pub(crate) span_id: u64,
}

impl BufferedOperation {
    pub fn from_buf(buf: &Vec<u8>, index: &mut usize) -> Self {
        let opcode: u64 = get_num_raw(buf, index);
        let opcode = OpCode::from_num(opcode);
        let span_id: u64 = get_num_raw(buf, index);
        BufferedOperation { opcode, span_id }
    }
}

