#!/usr/bin/env bash
# Builds passdroid-wasm twice (baseline and simd128) into pkg/ and pkg-simd/.
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli 0.2.125
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.125 --locked
set -euo pipefail
cd "$(dirname "$0")/../crates/passdroid-wasm"
OUT="$(cd ../../web-spike && pwd)"
# RUSTFLAGS replaces .cargo/config.toml rustflags, so the getrandom cfg is repeated.
GR='--cfg getrandom_backend="wasm_js"'

echo "== baseline =="
RUSTFLAGS="$GR" cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir "$OUT/pkg" --out-name passdroid_wasm \
  target/wasm32-unknown-unknown/release/passdroid_wasm.wasm

echo "== simd128 =="
RUSTFLAGS="$GR -C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown \
  --target-dir target-simd
wasm-bindgen --target web --out-dir "$OUT/pkg-simd" --out-name passdroid_wasm \
  target-simd/wasm32-unknown-unknown/release/passdroid_wasm.wasm

ls -l "$OUT/pkg/passdroid_wasm_bg.wasm" "$OUT/pkg-simd/passdroid_wasm_bg.wasm"
