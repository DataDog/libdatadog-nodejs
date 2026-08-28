import {
  backend,
  DDSketch,
  zstd_compress,
} from '@datadog/libdatadog'
import {
  RemoteConfigFetcher,
  setStorage,
} from '@datadog/libdatadog/remote-config'
import * as wasm from '@datadog/libdatadog/wasm'

const selectedBackend: 'wasm' = backend()
const compressed: Uint8Array = zstd_compress(new Uint8Array(16), 3)
const sketch = new DDSketch()

sketch.add(1)
sketch.addWithCount(2, 3)
const count: number = sketch.count()
const encoded: Uint8Array = sketch.encode()

const wasmBackend: typeof backend = wasm.backend
const wasmSketch: typeof DDSketch = wasm.DDSketch
const wasmCompress: typeof zstd_compress = wasm.zstd_compress
const remoteConfigFetcher = new RemoteConfigFetcher({
  clientId: 'client-id',
  runtimeId: 'runtime-id',
  service: 'service',
  env: 'env',
  appVersion: '1.0.0',
  tags: [],
  processTags: [],
  language: 'nodejs',
  tracerVersion: '1.0.0',
  url: 'http://127.0.0.1:8126',
  timeoutMs: 5000,
})

remoteConfigFetcher.setExtraServices([])
remoteConfigFetcher.setProductCapabilities([], [])
setStorage(runInStorage)

function runInStorage (callback: () => void): void {
  callback()
}

void selectedBackend
void compressed
void count
void encoded
void wasmBackend
void wasmSketch
void wasmCompress
void remoteConfigFetcher
