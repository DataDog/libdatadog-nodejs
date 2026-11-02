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
  apiKey?: string
  hostname?: string
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
  setIdentity(clientId: string, runtimeId: string, tags: string[]): void
  /** Returns unrecognized product and capability names. */
  setProductCapabilities(products: string[], capabilities: string[]): string[]
  /** Copies an unsigned, big-endian mask. Returns unrecognized product names. */
  setProductCapabilityMask(products: string[], capabilities: Uint8Array): string[]
}

export function setStorage(storage: (callback: () => void) => void): void
