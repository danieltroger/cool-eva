#!/bin/sh
set -eu

cd /opt/cool-eva/current
exec ./runtime/bin/node --experimental-strip-types ./src/index.ts
