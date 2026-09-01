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
  sendV04(payload: Uint8Array, done: () => void, log: AgentlessLogger): void
  close(): void
}

export interface AgentlessLogger {
  error(message: string, ...args: unknown[]): void
}

export function createAgentlessExporter(options: AgentlessExporterOptions): AgentlessExporter
export function backend(): 'wasm'

export function zstd_compress(data: Uint8Array, level: number): Uint8Array

export class DDSketch {
  add(point: number): void
  addWithCount(point: number, count: number): void
  count(): number
  encode(): Uint8Array
}
