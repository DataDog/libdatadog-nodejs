export interface AgentlessExporterOptions {
  endpoint: string
  apiKey: string
  hostname?: string
  env?: string
  service?: string
  version?: string
  runtimeId?: string
  containerId?: string
  tracerVersion: string
  languageVersion: string
  languageInterpreter: string
  timeoutMs?: number
}

export interface AgentlessExporter {
  sendV04(payload: Uint8Array): Promise<void>
  close(): void | Promise<void>
}

export function createAgentlessExporter(options: AgentlessExporterOptions): AgentlessExporter
export function backend(): 'native' | 'wasm'

export interface RemoteConfigFetcherOptions {
  clientId: string
  runtimeId: string
  service: string
  env: string
  appVersion: string
  tags: string[]
  processTags: string[]
  language: string
  tracerVersion: string
  url: string
  timeoutMs: number
  apiKey: string
  hostname: string
}

export interface RemoteConfigChange {
  kind: 'add' | 'update' | 'remove'
  path: string
  product: string
  configId: string
  name: string
  version: number
  contents?: string
}

export class RemoteConfigFetcher {
  constructor(options: RemoteConfigFetcherOptions)
  fetchChanges(): Promise<RemoteConfigChange[]>
  setConfigState(path: string, applyState: number, applyError?: string): void
  setExtraServices(services: string[]): void
  setProductCapabilities(products: string[], capabilities: string[]): string[]
}

export function zstd_compress(data: Uint8Array, level: number): Uint8Array

export class DDSketch {
  add(point: number): void
  addWithCount(point: number, count: number): void
  count(): number
  encode(): Uint8Array
}
