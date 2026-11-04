#!/bin/sh
set -eu

cd /opt/cool-eva/current
# Lazy Wasm compilation executed a PROT_NONE page on emulated A53; see docs/node-wasm-startup.md.
exec ./runtime/bin/node --no-wasm-lazy-compilation --experimental-strip-types ./src/index.ts
