import { instantiateNapiModuleSync } from '@emnapi/core'
import { getDefaultContext } from '@emnapi/runtime'
import { installCurrentThreadHosts } from '@napi-rs/async-runtime'

const asyncRuntimeExports = [
  'BindingRuntimeFlavor',
  'configureAsyncRuntime',
  'getAsyncRuntimeConfig',
  'getAsyncRuntimeMetrics',
  'resetAsyncRuntimeMetrics',
  'reserveCurrentThreadHostRegistration',
  'getCurrentThreadTaskHostContractVersion',
  'isCurrentThreadHostRegistrationActive',
  'registerCurrentThreadTaskHost',
  'unregisterCurrentThreadTaskHost',
  'registerTimerHost',
  'unregisterTimerHost',
]

export default function createLoader ({ createImports, setInstance }) {
  return function load (wasmBytes) {
    const wasmModule = new WebAssembly.Module(wasmBytes)
    const wasmBindgenImports = {
      './libdatadog_bg.js': createImports(),
    }
    const { napiModule } = instantiateNapiModuleSync(wasmModule, {
      asyncWorkPoolSize: 0,
      context: getDefaultContext(),
      overwriteImports (importObject) {
        Object.assign(importObject.env, importObject.napi, importObject.emnapi)
        Object.assign(importObject, wasmBindgenImports)
        return importObject
      },
      beforeInit ({ instance }) {
        setInstance(instance)
        for (const [name, value] of Object.entries(instance.exports)) {
          if (name.startsWith('__napi_register__')) value()
        }
      },
    })
    installCurrentThreadHosts(napiModule.exports, { installTimerHost: false })
    for (const name of asyncRuntimeExports) delete napiModule.exports[name]
    return napiModule.exports
  }
}
