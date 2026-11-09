// Opens the Phase 0 golden fixtures with Monocypher-wasm and times Argon2id.
// TEST password only (fixtures are not real vaults).
import { readFile } from 'node:fs/promises';
import { argon2id, aeadOpen } from './mono.mjs';

const GOLDEN = new URL('../../fixtures/golden/', import.meta.url);
const PASSWORD = 'phase0-golden-vectors';
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// AAD = serde_json::to_vec(VaultHeader): compact JSON, fields in struct order, camelCase.
// Rebuilt explicitly (not from the file's key order) so unknown/reordered keys cannot leak in.
function buildAad(h) {
  return enc.encode(JSON.stringify({
    magic: h.magic,
    version: h.version,
    vaultId: h.vaultId,
    kdf: {
      algorithm: h.kdf.algorithm,
      memoryKib: h.kdf.memoryKib,
      iterations: h.kdf.iterations,
      parallelism: h.kdf.parallelism,
      salt: h.kdf.salt,
      outputLen: h.kdf.outputLen,
    },
    cipher: { algorithm: h.cipher.algorithm },
    nonce: h.nonce,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  }));
}

// Deep equality on parsed JSON (key order irrelevant).
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && same(a[k], b[k]));
}

async function check(vaultFile, expectedFile) {
  const env = JSON.parse(await readFile(new URL(vaultFile, GOLDEN), 'utf8'));
  const expected = JSON.parse(await readFile(new URL(expectedFile, GOLDEN), 'utf8'));
  const h = env.header;
  const t0 = performance.now();
  const key = await argon2id(enc.encode(PASSWORD), b64(h.kdf.salt), h.kdf.memoryKib, h.kdf.iterations, h.kdf.parallelism);
  const kdfMs = performance.now() - t0;
  const plain = await aeadOpen(key, b64(h.nonce), buildAad(h), b64(env.payload));
  const ok = same(JSON.parse(dec.decode(plain)), expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${vaultFile}  (m=${h.kdf.memoryKib} KiB, kdf ${kdfMs.toFixed(0)} ms, plaintext ${plain.length} B)`);

  // Negative checks: wrong password and tampered AAD must be rejected.
  const badKey = await argon2id(enc.encode('wrong-password'), b64(h.kdf.salt), 8, 1, 1);
  let rejected = 0;
  try { await aeadOpen(badKey, b64(h.nonce), buildAad(h), b64(env.payload)); } catch { rejected++; }
  try { await aeadOpen(key, b64(h.nonce), buildAad({ ...h, updatedAt: 'x' }), b64(env.payload)); } catch { rejected++; }
  console.log(`${rejected === 2 ? 'PASS' : 'FAIL'}  ${vaultFile}  negative (wrong key + tampered AAD rejected: ${rejected}/2)`);
  return ok && rejected === 2;
}

async function bench(mKib) {
  const pass = enc.encode(PASSWORD), salt = new Uint8Array(16).fill(7);
  await argon2id(pass, salt, mKib, 3, 1); // warm-up
  const ms = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await argon2id(pass, salt, mKib, 3, 1);
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`Argon2id m=${mKib / 1024} MiB t=3 p=1: median ${ms[2].toFixed(0)} ms, min ${ms[0].toFixed(0)} ms, max ${ms[4].toFixed(0)} ms`);
}

const a = await check('desktop-64mib.pdvault', 'expected-desktop.json');
const b = await check('android-32mib.pdvault', 'expected-android.json');
await bench(65536);
await bench(32768);
process.exit(a && b ? 0 : 1);
