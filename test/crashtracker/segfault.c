#define NAPI_VERSION 1

#include <node_api.h>
#include <signal.h>
#include <stdio.h>

// TODO: Figure out how to cause an actual segmentation fault.
napi_value Boom(napi_env env, napi_callback_info info) {
  raise(SIGSEGV);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value boom;

  napi_create_function(env, NULL, 0, Boom, NULL, &boom);
  napi_set_named_property(env, exports, "boom", boom);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init);
