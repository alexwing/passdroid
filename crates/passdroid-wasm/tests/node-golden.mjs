// Node check of the WASM build against the golden vectors (Phase 0).
//
// Mirrors the semantics of crates/passdroid-core/tests/golden.rs, but drives the
// public wasm-bindgen exports of crates/passdroid-wasm/src/lib.rs. Test data only.
//
// Build the nodejs package first (see crates/passdroid-wasm/README or the
// commands below), then run:
//   cd crates/passdroid-wasm
//   cargo build --release --target wasm32-unknown-unknown
//   wasm-bindgen --target nodejs --out-dir pkg-node target/wasm32-unknown-unknown/release/passdroid_wasm.wasm
//   node tests/node-golden.mjs [pkgDir]
//
// pkgDir defaults to ../pkg-node relative to this script. Exit code 1 if any check fails.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual, strictEqual, notStrictEqual } from 'node:assert';

const PASSWORD = 'phase0-golden-vectors';
const WRONG_PASSWORD = 'not-the-password';
const WRONG_PASSWORD_CODE = 'master_password_incorrect';

const require = createRequire(import.meta.url);
const pkgDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(fileURLToPath(new URL('../pkg-node', import.meta.url)));
const fixturesDir = fileURLToPath(new URL('../../../fixtures/golden/', import.meta.url));

// wasm-bindgen --target nodejs emits CommonJS. The repo root package.json has
// "type": "module", which would make Node parse that file as ESM and fail. The
// output dir is gitignored build output, so pin it to CommonJS with its own
// package.json (the nearest one wins). Written only when missing.
const pkgJson = resolve(pkgDir, 'package.json');
if (!existsSync(pkgJson)) {
  writeFileSync(pkgJson, '{ "type": "commonjs" }\n');
}

// --target nodejs loads the .wasm itself at require time (synchronously).
const api = require(resolve(pkgDir, 'passdroid_wasm.js'));

const readFixture = (name) => readFileSync(resolve(fixturesDir, name), 'utf8');

// Same params golden.rs asserts per fixture (memory is the only varying one).
const FIXTURES = [
  {
    label: 'desktop-64mib',
    vault: 'desktop-64mib.pdvault',
    expected: 'expected-desktop.json',
    memoryKib: 64 * 1024,
    icon: 'shield',
  },
  {
    label: 'android-32mib',
    vault: 'android-32mib.pdvault',
    expected: 'expected-android.json',
    memoryKib: 32 * 1024,
    icon: 'shield',
  },
  {
    label: 'android-real-32mib',
    vault: 'android-real-32mib.pdvault',
    expected: 'expected-android-real.json',
    memoryKib: 32 * 1024,
    icon: undefined,
  },
];

let passed = 0;
let failed = 0;

// Each check is synchronous (the wasm API is sync). Errors are reported, not thrown,
// so one failing check does not hide the rest.
function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (err) {
    failed += 1;
    const firstLine = String(err && err.message ? err.message : err).split('\n')[0];
    console.log(`FAIL  ${name}  ${firstLine}`);
  }
}

// Error thrown by a wasm function: JsError message is the core error code.
function errorCodeOf(fn) {
  try {
    fn();
  } catch (err) {
    return String(err && err.message ? err.message : err);
  }
  throw new Error('expected an error, got success');
}

// Pretty JSON exactly as serde_json::to_string_pretty writes it (2 spaces, no
// trailing newline). JSON.stringify with indent 2 produces the same bytes here
// and keeps key order, so a round trip must reproduce the input string.
const isStablePretty = (text) => JSON.stringify(JSON.parse(text), null, 2) === text;

console.log(`golden vectors via ${pkgDir}`);

for (const f of FIXTURES) {
  const prefix = f.label;
  const vault = readFixture(f.vault);
  const expectedText = readFixture(f.expected);
  const expected = JSON.parse(expectedText);

  check(`${prefix}: header params (Argon2id, t=3, p=1, 32 bytes, XChaCha20-Poly1305)`, () => {
    const header = JSON.parse(api.read_header(vault));
    strictEqual(header.magic, 'passdroid-vault-v1');
    strictEqual(header.version, 1);
    strictEqual(header.kdf.algorithm, 'Argon2id');
    strictEqual(header.kdf.memoryKib, f.memoryKib);
    strictEqual(header.kdf.iterations, 3);
    strictEqual(header.kdf.parallelism, 1);
    strictEqual(header.kdf.outputLen, 32);
    strictEqual(header.cipher.algorithm, 'XChaCha20-Poly1305');
    return `memoryKib=${header.kdf.memoryKib}`;
  });

  let opened = null;
  check(`${prefix}: open_vault == expected JSON`, () => {
    opened = JSON.parse(api.open_vault(vault, PASSWORD));
    deepStrictEqual(opened, expected);
    const live = expected.entries.filter((e) => e.deletedAt == null).length;
    return `entries=${expected.entries.length} visible=${live}`;
  });

  check(`${prefix}: status (visible entry count, icon, revision)`, () => {
    const visible = (opened.entries || []).filter((e) => e.deletedAt == null).length;
    strictEqual(visible, 3);
    strictEqual(opened.settings && opened.settings.icon, f.icon);
    strictEqual(opened.revision, expected.revision);
  });

  if (prefix === 'android-real-32mib') {
    check(`${prefix}: entry titles, notes and login fields`, () => {
      deepStrictEqual(
        opened.entries.map((e) => e.title),
        ['Café 😅 Ñandú', 'Fixture Login', 'Minimal'],
      );
      strictEqual(opened.entries[0].notes, 'Notas café mañana');
      strictEqual(opened.entries[1].username, 'fixture-user');
      strictEqual(opened.entries[1].url, 'https://example.invalid/login');
    });
  }

  check(`${prefix}: wrong password rejected (${WRONG_PASSWORD_CODE})`, () => {
    strictEqual(errorCodeOf(() => api.open_vault(vault, WRONG_PASSWORD)), WRONG_PASSWORD_CODE);
  });

  check(`${prefix}: reseal_vault -> reopen == expected, fresh nonce, same params`, () => {
    const resealed = api.reseal_vault(vault, PASSWORD);
    const reopened = JSON.parse(api.open_vault(resealed, PASSWORD));
    deepStrictEqual(reopened, expected);

    const before = JSON.parse(api.read_header(vault));
    const after = JSON.parse(api.read_header(resealed));
    notStrictEqual(after.nonce, before.nonce);
    strictEqual(after.vaultId, before.vaultId);
    strictEqual(after.kdf.memoryKib, f.memoryKib);
    strictEqual(after.kdf.salt, before.kdf.salt);
    if (!isStablePretty(resealed)) {
      throw new Error('resealed envelope is not stable pretty JSON');
    }
  });

  check(`${prefix}: save_vault bumps revision by one, entries unchanged`, () => {
    const saved = api.save_vault(vault, PASSWORD);
    const reopened = JSON.parse(api.open_vault(saved, PASSWORD));
    strictEqual(reopened.revision, expected.revision + 1);
    deepStrictEqual(reopened.entries, expected.entries);
    if (!isStablePretty(saved)) {
      throw new Error('saved envelope is not stable pretty JSON');
    }
  });
}

check('generate_password(24, all classes) length and type', () => {
  const pw = api.generate_password(24, true, true, true, true);
  strictEqual(typeof pw, 'string');
  strictEqual(pw.length, 24);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
