// Browser-less sanity run (Node 24): loads the WASM pkg with initSync, opens both
// golden fixtures, compares with expected JSON and times Argon2id 64 MiB once for
// Rust-WASM and hash-wasm. Exit code 1 if anything mismatches.
//   node node-check.mjs [pkg|pkg-simd]

import { readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const variant = process.argv[2] || 'pkg';
const fixtures = (name) => readFileSync(new URL(`../fixtures/golden/${name}`, import.meta.url), 'utf8');
const PASSWORD = 'phase0-golden-vectors';

const api = await import(pathToFileURL(`${here}${variant}/passdroid_wasm.js`).href);
const wasm = api.initSync({ module: readFileSync(`${here}${variant}/passdroid_wasm_bg.wasm`) });
const { argon2id } = await import('./vendor/hash-wasm/index.esm.min.js');

let failed = false;
const hex = (b) => Buffer.from(b).toString('hex');
const ms = (t0) => (performance.now() - t0).toFixed(0) + ' ms';
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed = true;
};

console.log(`variant: ${variant}, node ${process.version}`);

for (const [label, vaultFile, expectedFile] of [
  ['desktop-64mib', 'desktop-64mib.pdvault', 'expected-desktop.json'],
  ['android-32mib', 'android-32mib.pdvault', 'expected-android.json'],
]) {
  const vault = fixtures(vaultFile);
  const expected = JSON.parse(fixtures(expectedFile));

  let t0 = performance.now();
  const opened = JSON.parse(api.open_vault(vault, PASSWORD));
  const openMs = ms(t0);
  let equal = true;
  try {
    deepStrictEqual(opened, expected);
  } catch {
    equal = false;
  }
  check(`${label}: open == expected`, equal, openMs);

  t0 = performance.now();
  const resealed = api.reseal_vault(vault, PASSWORD);
  const resealMs = ms(t0);
  const reopened = JSON.parse(api.open_vault(resealed, PASSWORD));
  let reEqual = true;
  try {
    deepStrictEqual(reopened, expected);
  } catch {
    reEqual = false;
  }
  const h1 = JSON.parse(api.read_header(vault));
  const h2 = JSON.parse(api.read_header(resealed));
  check(`${label}: reseal + reopen == expected, fresh nonce`, reEqual && h1.nonce !== h2.nonce && h1.vaultId === h2.vaultId, resealMs);

  let code = '';
  try {
    api.open_vault(vault, 'not-the-test-password');
  } catch (e) {
    code = e.message;
  }
  check(`${label}: wrong password rejected`, code === 'master_password_incorrect', code);
}

const pw = api.generate_password(24, true, true, true, true);
check('generate_password(24, all classes)', typeof pw === 'string' && pw.length === 24, `len ${pw.length}`);

// Argon2id 64 MiB t=3 p=1, same salt/password for both engines.
const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
const saltB64 = Buffer.from(salt).toString('base64');
const benchPw = 'phase0-bench-password';

let t0 = performance.now();
const kRust = api.derive_key_bench(benchPw, saltB64, 65536, 3, 1);
const rustMs = performance.now() - t0;
console.log(`Argon2id 64 MiB, Rust-WASM (${variant}): ${rustMs.toFixed(0)} ms  (memory ${(wasm.memory.buffer.byteLength / 1048576).toFixed(0)} MiB)`);

t0 = performance.now();
const kHash = await argon2id({ password: benchPw, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' });
const hashMs = performance.now() - t0;
console.log(`Argon2id 64 MiB, hash-wasm: ${hashMs.toFixed(0)} ms`);
check('Rust-WASM and hash-wasm give identical bytes', hex(kRust) === hex(kHash), hex(kRust));

process.exit(failed ? 1 : 0);
