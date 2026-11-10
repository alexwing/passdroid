#!/bin/sh
# Build monocypher.wasm with the scoop LLVM clang (wasm-ld in the same dir).
set -e
cd "$(dirname "$0")"
CLANG=/c/Users/Windows/scoop/apps/llvm/current/bin/clang
FLAGS="--target=wasm32 -O3 -nostdlib -ffreestanding -fno-builtin -ffunction-sections -DNDEBUG"
$CLANG $FLAGS -c monocypher.c -o monocypher.o
$CLANG $FLAGS -c shim.c -o shim.o
$CLANG --target=wasm32 -nostdlib -fuse-ld=lld monocypher.o shim.o -o monocypher.wasm \
  -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=1048576 \
  -Wl,-z,stack-size=262144 -Wl,--gc-sections -Wl,--strip-all
rm -f monocypher.o shim.o
ls -l monocypher.wasm
