// Monocypher 4.0.2 (wasm32) loader for the Passdroid vault: Argon2id + XChaCha20-Poly1305.
// Works in Node >= 18 (fs read) and in the browser (fetch + WebAssembly.instantiate).

const WASM_URL = new URL('./monocypher.wasm', import.meta.url);

let instPromise = null;

async function loadBytes(url) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { readFile } = await import('node:fs/promises');
    return readFile(url);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wasm fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

// Optional explicit init: init(urlOrBytes) lets a bundler/app choose where the .wasm lives.
export function init(source = WASM_URL) {
  if (!instPromise) {
    instPromise = (async () => {
      const bytes = source instanceof Uint8Array || source instanceof ArrayBuffer ? source : await loadBytes(source);
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports;
    })();
  }
  return instPromise;
}

// Copy `src` into wasm memory; memory.grow detaches old views, so build the view on every access.
function put(wasm, src) {
  const ptr = wasm.pd_alloc(Math.max(src.length, 1));
  if (!ptr) throw new Error('wasm_out_of_memory');
  new Uint8Array(wasm.memory.buffer, ptr, src.length).set(src);
  return ptr;
}

// Argon2id v1.3 -> 32-byte key. mKib in KiB.
export async function argon2id(passwordBytes, saltBytes, mKib, t, p) {
  const wasm = await init();
  wasm.pd_reset();
  try {
    const pass = put(wasm, passwordBytes);
    const salt = put(wasm, saltBytes);
    const out = wasm.pd_alloc(32);
    if (!out) throw new Error('wasm_out_of_memory');
    const rc = wasm.pd_argon2id(pass, passwordBytes.length, salt, saltBytes.length, mKib, t, p, out);
    if (rc === -1) throw new Error('invalid_kdf_params');
    if (rc !== 0) throw new Error('wasm_out_of_memory');
    return new Uint8Array(wasm.memory.buffer, out, 32).slice();
  } finally {
    wasm.pd_reset();
  }
}

// XChaCha20-Poly1305 open. ciphertext = ct || 16-byte tag. Returns plaintext or throws 'decryption_failed'.
export async function aeadOpen(key, nonce, ad, ciphertext) {
  if (key.length !== 32) throw new Error('invalid_key');
  if (nonce.length !== 24) throw new Error('invalid_nonce');
  const wasm = await init();
  wasm.pd_reset();
  try {
    const k = put(wasm, key);
    const n = put(wasm, nonce);
    const a = put(wasm, ad);
    const c = put(wasm, ciphertext);
    const outLen = Math.max(ciphertext.length - 16, 0);
    const out = wasm.pd_alloc(Math.max(outLen, 1));
    if (!out) throw new Error('wasm_out_of_memory');
    const rc = wasm.pd_aead_open(k, n, a, ad.length, c, ciphertext.length, out);
    if (rc !== 0) throw new Error('decryption_failed');
    return new Uint8Array(wasm.memory.buffer, out, outLen).slice();
  } finally {
    wasm.pd_reset();
  }
}
