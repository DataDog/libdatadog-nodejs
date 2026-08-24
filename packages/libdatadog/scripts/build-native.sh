#!/usr/bin/env bash
set -euo pipefail

napi build -r --platform \
  --manifest-path ../../crates/libdatadog/Cargo.toml \
  -o dist/native \
  "$@"
