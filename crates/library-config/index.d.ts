/* tslint:disable */
/* eslint-disable */

/* auto-generated by NAPI-RS */

export type JsConfigurator = Configurator
export declare class Configurator {
  constructor(debugLogs: boolean)
  setEnvp(envp: Array<string>): void
  setArgs(args: Array<string>): void
  getConfiguration(configString: string): Record<string, string>
}
