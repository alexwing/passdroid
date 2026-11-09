// Module worker: one engine per worker instance, so memory growth and aborts
// (an OOM in wasm traps and poisons that instance) never leak between tests.
//
// Protocol: postMessage({ id, op, ... }) -> postMessage({ id, ok, ... }).
//   op "init"   { engine }                     engine: wasm | wasm-simd | hash-wasm
//   op "kdf"    { password, saltB64, m, t, p, runs }   1 warm-up + `runs` timed
//   op "golden" { vault, expected, password }
// Any thrown error is returned as { ok: false, error: { name, message } }.

let engine = null;
let api = null; // wasm-bindgen module, or hash-wasm module
let wasmExports = null;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const memBytes = () => (wasmExports ? wasmExports.memory.buffer.byteLength : null);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

async function init({ engine: e }) {
  engine = e;
  const t0 = performance.now();
  if (e === 'hash-wasm') {
    api = await import('./vendor/hash-wasm/index.esm.min.js');
  } else if (e === 'monocypher') {
    // Monocypher 4 (the Kindle client's C library) compiled to freestanding wasm32.
    api = await import('./vendor/monocypher/mono.mjs');
    await api.init();
  } else {
    const dir = e === 'wasm-simd' ? './pkg-simd' : './pkg';
    api = await import(`${dir}/passdroid_wasm.js`);
    wasmExports = await api.default();
  }
  return { initMs: performance.now() - t0, memoryBytes: memBytes() };
}

// One Argon2id derivation, returned as { ms, key } (key as hex).
async function deriveOnce({ password, saltB64, m, t, p }) {
  const t0 = performance.now();
  let key;
  if (engine === 'hash-wasm') {
    key = await api.argon2id({
      password,
      salt: b64ToBytes(saltB64),
      parallelism: p,
      iterations: t,
      memorySize: m, // KiB
      hashLength: 32,
      outputType: 'binary',
    });
  } else if (engine === 'monocypher') {
    key = await api.argon2id(new TextEncoder().encode(password), b64ToBytes(saltB64), m, t, p);
  } else {
    key = api.derive_key_bench(password, saltB64, m, t, p);
  }
  return { ms: performance.now() - t0, key: hex(key) };
}

async function kdf(args) {
  const runs = args.runs ?? 5;
  const warmup = await deriveOnce(args);
  const timed = [];
  for (let i = 0; i < runs; i++) timed.push(await deriveOnce(args));
  return {
    warmupMs: warmup.ms,
    runsMs: timed.map((r) => r.ms),
    keys: [warmup.key, ...timed.map((r) => r.key)],
    memoryBytes: memBytes(),
  };
}

async function golden({ vault, expected, password }) {
  const out = { steps: {} };
  const time = async (name, fn) => {
    const t0 = performance.now();
    const value = await fn();
    out.steps[name] = { ...out.steps[name], ms: performance.now() - t0 };
    return value;
  };

  const header = JSON.parse(api.read_header(vault));
  out.kdf = header.kdf;

  const opened = JSON.parse(await time('open', () => api.open_vault(vault, password)));
  out.steps.open.pass = deepEqual(opened, expected);

  const resealed = await time('reseal', () => api.reseal_vault(vault, password));
  const h2 = JSON.parse(api.read_header(resealed));
  out.steps.reseal.pass = h2.nonce !== header.nonce && h2.vaultId === header.vaultId;

  const reopened = JSON.parse(await time('reopen', () => api.open_vault(resealed, password)));
  out.steps.reopen.pass = deepEqual(reopened, expected);

  await time('wrongPassword', async () => {
    out.steps.wrongPassword = { pass: false };
    try {
      api.open_vault(vault, 'not-the-test-password');
    } catch (err) {
      out.steps.wrongPassword.error = String(err && err.message);
      out.steps.wrongPassword.pass = out.steps.wrongPassword.error === 'master_password_incorrect';
    }
  });

  out.pass = Object.values(out.steps).every((s) => s.pass);
  out.memoryBytes = memBytes();
  return out;
}

const ops = { init, kdf, golden };

self.onmessage = async (ev) => {
  const { id, op, ...args } = ev.data;
  try {
    const result = await ops[op](args);
    self.postMessage({ id, ok: true, ...result });
  } catch (err) {
    // wasm traps on allocation failure surface as RuntimeError("unreachable")
    // or RangeError("WebAssembly.Memory(): could not allocate memory").
    self.postMessage({
      id,
      ok: false,
      error: { name: String(err && err.name), message: String(err && err.message ? err.message : err) },
      memoryBytes: memBytes(),
    });
  }
};
