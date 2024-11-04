#define NAPI_VERSION 6

#include <node_api.h>
#include <signal.h>
#include <stdio.h>

napi_value Boom(napi_env env, napi_callback_info info) {
  int* data;

  napi_get_instance_data(env, &data);

  *data = 1234;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value boom;

  napi_create_function(env, NULL, 0, Boom, NULL, &boom);
  napi_set_named_property(env, exports, "boom", boom);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init);
