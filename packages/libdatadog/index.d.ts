export interface ObfuscationReplaceRule {
  name: string
  pattern: string
  repl: string
}

export interface ObfuscationHttpConfig {
  remove_query_string?: boolean
  remove_paths_with_digits?: boolean
}

export interface ObfuscationMemcachedConfig {
  enabled?: boolean
  keep_command?: boolean
}

export interface ObfuscationRedisConfig {
  enabled?: boolean
  remove_all_args?: boolean
}

export interface ObfuscationCreditCardConfig {
  enabled?: boolean
  luhn?: boolean
  keep_values?: string[]
}

export type SqlObfuscationMode =
  | 'unspecified'
  | 'normalize_only'
  | 'obfuscate_only'
  | 'obfuscate_and_normalize'

export interface ObfuscationSqlConfig {
  replace_digits?: boolean
  keep_sql_alias?: boolean
  dollar_quoted_func?: boolean
  keep_null?: boolean
  keep_boolean?: boolean
  keep_positional_parameter?: boolean
  keep_trailing_semicolon?: boolean
  keep_identifier_quotation?: boolean
  replace_bind_parameter?: boolean
  remove_space_between_parentheses?: boolean
  keep_json_path?: boolean
  obfuscation_mode?: SqlObfuscationMode
}

export interface ObfuscationJsonConfig {
  enabled?: boolean
  keep_keys?: string[]
}

export interface ObfuscationConfig {
  tag_replace_rules?: ObfuscationReplaceRule[]
  http?: ObfuscationHttpConfig
  memcached?: ObfuscationMemcachedConfig
  redis?: ObfuscationRedisConfig
  valkey?: ObfuscationRedisConfig
  credit_cards?: ObfuscationCreditCardConfig
  sql?: ObfuscationSqlConfig
  elasticsearch?: ObfuscationJsonConfig
  opensearch?: ObfuscationJsonConfig
  mongodb?: ObfuscationJsonConfig
}

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
  obfuscation?: ObfuscationConfig
}

interface AgentlessTransportAgent {
  addRequest(request: object, options: object): void
}

export interface AgentlessTransportOptions {
  /** Borrowed Node.js HTTP agent. The exporter does not destroy it. */
  agent?: AgentlessTransportAgent
}

export interface AgentlessExporter {
  sendV04(payload: Uint8Array, done: () => void, log: AgentlessLogger): void
  close(): void
}

export interface AgentlessLogger {
  error(message: string, ...args: unknown[]): void
}

export function createAgentlessExporter(
  options: AgentlessExporterOptions,
  transportOptions?: AgentlessTransportOptions
): AgentlessExporter
export function backend(): 'wasm'

export function zstd_compress(data: Uint8Array, level: number): Uint8Array

export class DDSketch {
  add(point: number): void
  addWithCount(point: number, count: number): void
  count(): number
  encode(): Uint8Array
}
