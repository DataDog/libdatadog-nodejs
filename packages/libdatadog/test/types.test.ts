import {
  type AgentlessLogger,
  backend,
  createAgentlessExporter,
  DDSketch,
  RemoteConfigFetcher,
  zstd_compress,
} from '@datadog/libdatadog'
import * as wasm from '@datadog/libdatadog/wasm'

const selectedBackend: 'native' | 'wasm' = backend()
const compressed: Uint8Array = zstd_compress(new Uint8Array(16), 3)
const sketch = new DDSketch()
const remoteConfig = new RemoteConfigFetcher({
  clientId: 'client-id',
  runtimeId: 'runtime-id',
  service: 'service',
  env: 'test',
  appVersion: '1.0.0',
  tags: [],
  processTags: [],
  language: 'nodejs',
  tracerVersion: '1.2.3',
  url: 'https://datadoghq.com',
  timeoutMs: 5_000,
  apiKey: 'test-api-key',
  hostname: 'test-host',
})
const agentlessExporter = createAgentlessExporter({
  endpoint: 'https://example.test/api/v2/spans',
  apiKey: 'test-api-key',
  tracerVersion: '1.2.3',
  languageVersion: '22.0.0',
  languageInterpreter: 'v8',
})
const logger: AgentlessLogger = {
  error () {},
}

sketch.add(1)
sketch.addWithCount(2, 3)
const count: number = sketch.count()
const encoded: Uint8Array = sketch.encode()
const changes = remoteConfig.fetchChanges()
agentlessExporter.sendV04(new Uint8Array(16), () => {}, logger)
agentlessExporter.close()
remoteConfig.setExtraServices(['other-service'])
remoteConfig.setProductCapabilities(['ASM_FEATURES'], ['ASM_ACTIVATION'])

const wasmBackend: typeof backend = wasm.backend
const wasmSketch: typeof DDSketch = wasm.DDSketch
const wasmCompress: typeof zstd_compress = wasm.zstd_compress
const wasmRemoteConfig: typeof RemoteConfigFetcher = wasm.RemoteConfigFetcher

void selectedBackend
void compressed
void count
void encoded
void changes
void wasmBackend
void wasmSketch
void wasmCompress
void wasmRemoteConfig
