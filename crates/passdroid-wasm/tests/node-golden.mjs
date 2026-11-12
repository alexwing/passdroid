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
import { deepStrictEqual, strictEqual, notStrictEqual, ok } from 'node:assert';
import { randomBytes } from 'node:crypto';

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

// ---------------------------------------------------------------------------
// Worker API: split open/seal around a derived key, plus the session ops on JSON.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const T_OLD = '2026-11-09T10:00:00.000Z';
const T_NEW = '2026-11-09T11:00:00.000Z';

const newEntry = (id, title, updatedAt) => ({
  id,
  title,
  username: '',
  password: '',
  url: '',
  notes: '',
  createdAt: T_OLD,
  updatedAt,
  deletedAt: null,
  conflict: false,
});

for (const f of FIXTURES) {
  const prefix = f.label;
  const vault = readFixture(f.vault);
  const expected = JSON.parse(readFixture(f.expected));
  const envelopeHeaderJson = api.parseHeader(vault);
  const header = JSON.parse(envelopeHeaderJson);
  const kdfJson = JSON.stringify(header.kdf);
  let key = null;
  let openedText = null;

  check(`${prefix}: [worker] parseHeader == read_header`, () => {
    strictEqual(envelopeHeaderJson, api.read_header(vault));
  });

  check(`${prefix}: [worker] checkKdfBounds accepts fixture KDF, rejects memoryKib 1024`, () => {
    api.checkKdfBounds(kdfJson);
    const manipulated = JSON.stringify({ ...header.kdf, memoryKib: 1024 });
    strictEqual(errorCodeOf(() => api.checkKdfBounds(manipulated)), 'kdf_out_of_bounds');
  });

  check(`${prefix}: [worker] deriveKey -> 32-byte Uint8Array`, () => {
    key = api.deriveKey(PASSWORD, kdfJson);
    ok(key instanceof Uint8Array, 'not a Uint8Array');
    strictEqual(key.length, 32);
  });

  check(`${prefix}: [worker] deriveKey rejects out-of-bounds KDF without deriving`, () => {
    const lowMemory = JSON.stringify({ ...header.kdf, memoryKib: 1024 });
    strictEqual(errorCodeOf(() => api.deriveKey(PASSWORD, lowMemory)), 'kdf_out_of_bounds');
    // Heavy params that would take seconds to derive: the bounds check must
    // answer before Argon2 runs, so the call is effectively instant.
    const heavy = JSON.stringify({ ...header.kdf, memoryKib: 131072, iterations: 11 });
    const started = performance.now();
    strictEqual(errorCodeOf(() => api.deriveKey(PASSWORD, heavy)), 'kdf_out_of_bounds');
    const ms = performance.now() - started;
    ok(ms < 1000, `took ${Math.round(ms)} ms`);
    return `fast-fail ${Math.round(ms)}ms`;
  });

  check(`${prefix}: [worker] openWithKey == open_vault JSON == expected`, () => {
    openedText = api.openWithKey(vault, key);
    strictEqual(openedText, api.open_vault(vault, PASSWORD));
    deepStrictEqual(JSON.parse(openedText), expected);
  });

  check(`${prefix}: [worker] openWithKey: random 32-byte key -> master_password_incorrect`, () => {
    const wrong = new Uint8Array(randomBytes(32));
    strictEqual(errorCodeOf(() => api.openWithKey(vault, wrong)), 'master_password_incorrect');
  });

  check(`${prefix}: [worker] openWithKey: 31-byte key -> invalid_key`, () => {
    strictEqual(errorCodeOf(() => api.openWithKey(vault, new Uint8Array(31))), 'invalid_key');
  });

  check(`${prefix}: [worker] sealWithKey(bump=true): revision+1, fresh nonce, reopens with key`, () => {
    const sealed = api.sealWithKey(envelopeHeaderJson, openedText, key, true);
    const reopened = JSON.parse(api.openWithKey(sealed, key));
    deepStrictEqual(reopened, { ...expected, revision: expected.revision + 1 });

    const after = JSON.parse(api.parseHeader(sealed));
    notStrictEqual(after.nonce, header.nonce);
    notStrictEqual(after.updatedAt, header.updatedAt);
    strictEqual(after.vaultId, header.vaultId);
    strictEqual(after.kdf.salt, header.kdf.salt);
    if (!isStablePretty(sealed)) {
      throw new Error('sealed envelope is not stable pretty JSON');
    }
  });

  check(`${prefix}: [worker] sealWithKey(bump=false): revision unchanged, fresh nonce`, () => {
    const sealed = api.sealWithKey(envelopeHeaderJson, openedText, key, false);
    deepStrictEqual(JSON.parse(api.openWithKey(sealed, key)), expected);
    notStrictEqual(JSON.parse(api.parseHeader(sealed)).nonce, header.nonce);
  });

  check(`${prefix}: [worker] sealWithKey: 31-byte key -> invalid_key`, () => {
    const short = new Uint8Array(31);
    strictEqual(errorCodeOf(() => api.sealWithKey(envelopeHeaderJson, openedText, short, true)), 'invalid_key');
  });

  check(`${prefix}: [worker] VaultData unknown field survives open->upsert->seal->open`, () => {
    const withFuture = { ...expected, futureField: { a: 1 } };
    const env0 = api.sealWithKey(envelopeHeaderJson, JSON.stringify(withFuture), key, false);
    const data1 = api.openWithKey(env0, key);
    const upserted = JSON.parse(api.upsertEntry(data1, JSON.stringify({ title: 'Future test' })));
    const env1 = api.sealWithKey(api.parseHeader(env0), JSON.stringify(upserted.data), key, true);
    const data2 = JSON.parse(api.openWithKey(env1, key));
    deepStrictEqual(data2.futureField, { a: 1 });
    strictEqual(data2.revision, expected.revision + 1);
    strictEqual(data2.entries.length, expected.entries.length + 1);
  });

  check(`${prefix}: [worker] upsertEntry new: id generated, timestamps set, title trimmed`, () => {
    const res = JSON.parse(api.upsertEntry(openedText, JSON.stringify({ title: '  Nuevo  ', username: 'u', password: 'p' })));
    ok(UUID_RE.test(res.id), `id ${res.id}`);
    const added = res.data.entries.find((e) => e.id === res.id);
    strictEqual(added.title, 'Nuevo');
    strictEqual(added.username, 'u');
    ok(added.createdAt && added.createdAt === added.updatedAt, 'timestamps');
    strictEqual(res.data.entries.length, expected.entries.length + 1);
    strictEqual(res.data.revision, expected.revision);
  });

  check(`${prefix}: [worker] upsertEntry edit keeps unknown field "favorite"`, () => {
    const live = JSON.parse(openedText).entries.find((e) => e.deletedAt == null);
    // Edit with the unknown field present in the incoming JSON.
    const first = JSON.parse(api.upsertEntry(openedText, JSON.stringify({ ...live, favorite: true, title: 'Edited once' })));
    const stored = first.data.entries.find((e) => e.id === live.id);
    strictEqual(stored.favorite, true);
    strictEqual(stored.title, 'Edited once');
    strictEqual(stored.createdAt, live.createdAt);
    // Edit from a client that does not know the field: it must survive.
    const { favorite, ...withoutFavorite } = stored;
    const second = JSON.parse(api.upsertEntry(JSON.stringify(first.data), JSON.stringify({ ...withoutFavorite, title: 'Edited twice' })));
    const again = second.data.entries.find((e) => e.id === live.id);
    strictEqual(again.favorite, true);
    strictEqual(again.title, 'Edited twice');
    strictEqual(second.data.entries.length, expected.entries.length);
  });

  check(`${prefix}: [worker] upsertEntry blank title -> entry_title_required`, () => {
    strictEqual(errorCodeOf(() => api.upsertEntry(openedText, JSON.stringify({ title: '   ' }))), 'entry_title_required');
  });

  check(`${prefix}: [worker] deleteEntry -> tombstone, hidden from visibleEntries`, () => {
    const target = JSON.parse(openedText).entries.find((e) => e.deletedAt == null);
    const visibleBefore = JSON.parse(api.visibleEntries(openedText));
    const res = JSON.parse(api.deleteEntry(openedText, target.id));
    strictEqual(res.existed, true);
    const tomb = res.data.entries.find((e) => e.id === target.id);
    ok(tomb && tomb.deletedAt, 'tombstone kept in data');
    strictEqual(res.data.entries.length, expected.entries.length);
    const visibleAfter = JSON.parse(api.visibleEntries(JSON.stringify(res.data)));
    strictEqual(visibleAfter.length, visibleBefore.length - 1);
    ok(!visibleAfter.some((e) => e.id === target.id), 'tombstone still visible');
    strictEqual(JSON.parse(api.deleteEntry(openedText, 'no-such-id')).existed, false);
  });

  check(`${prefix}: [worker] visibleEntries == live entries of expected`, () => {
    const live = expected.entries.filter((e) => e.deletedAt == null);
    const visible = JSON.parse(api.visibleEntries(openedText));
    strictEqual(visible.length, live.length);
    ok(visible.every((e) => e.deletedAt == null));
    return `visible=${visible.length}`;
  });

  check(`${prefix}: [worker] mergeSession: parallel additions with empty base`, () => {
    const remote = { revision: 5, deviceId: 'remote-dev', entries: [newEntry('remote-add', 'Remote add', T_NEW)], settings: { icon: 'remote' }, extra: {} };
    const local = { revision: 4, deviceId: 'local-dev', entries: [newEntry('local-add', 'Local add', T_NEW)], settings: { icon: 'local' } };
    const merged = JSON.parse(api.mergeSession('[]', JSON.stringify(remote), JSON.stringify(local), false));
    const ids = merged.entries.map((e) => e.id).sort();
    deepStrictEqual(ids, ['local-add', 'remote-add']);
    strictEqual(merged.revision, 5);
    deepStrictEqual(merged.settings, { icon: 'remote' });
    const dirty = JSON.parse(api.mergeSession('[]', JSON.stringify(remote), JSON.stringify(local), true));
    deepStrictEqual(dirty.settings, { icon: 'local' });
  });

  check(`${prefix}: [worker] mergeSession: parallel additions over the fixture base`, () => {
    const remote = { ...expected, revision: expected.revision + 1, entries: [...expected.entries, newEntry('remote-add', 'Remote add', T_NEW)] };
    const local = { ...expected, entries: [...expected.entries, newEntry('local-add', 'Local add', T_NEW)] };
    const merged = JSON.parse(api.mergeSession(JSON.stringify(expected.entries), JSON.stringify(remote), JSON.stringify(local), false));
    strictEqual(merged.entries.length, expected.entries.length + 2);
    ok(merged.entries.some((e) => e.id === 'remote-add'), 'remote add missing');
    ok(merged.entries.some((e) => e.id === 'local-add'), 'local add missing');
    strictEqual(merged.revision, expected.revision + 1);
  });
}

check('checkRollback: remote_rollback / invalid_revision / ok cases', () => {
  strictEqual(errorCodeOf(() => api.checkRollback(5, 6, undefined)), 'remote_rollback');
  strictEqual(errorCodeOf(() => api.checkRollback(6, 6, 7)), 'remote_rollback');
  strictEqual(api.checkRollback(7, 6, 7), undefined);
  strictEqual(api.checkRollback(6, 6, null), undefined);
  strictEqual(errorCodeOf(() => api.checkRollback(-1, 0, undefined)), 'invalid_revision');
  strictEqual(errorCodeOf(() => api.checkRollback(1.5, 0, undefined)), 'invalid_revision');
  strictEqual(errorCodeOf(() => api.checkRollback(1, 0, -3)), 'invalid_revision');
  strictEqual(errorCodeOf(() => api.checkRollback(NaN, 0, undefined)), 'invalid_revision');
});

check('newVault: opens with the derived key, empty, revision 1, KDF within bounds', () => {
  const envelope = api.newVault('a-new-master-password');
  const header = JSON.parse(api.parseHeader(envelope));
  strictEqual(api.checkKdfBounds(JSON.stringify(header.kdf)), undefined);
  const key = api.deriveKey('a-new-master-password', JSON.stringify(header.kdf));
  const data = JSON.parse(api.openWithKey(envelope, key));
  strictEqual(data.entries.length, 0);
  strictEqual(data.revision, 1);
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(header.vaultId), 'vaultId is not a uuid');
  strictEqual(errorCodeOf(() => api.openWithKey(envelope, api.deriveKey('another-password', JSON.stringify(header.kdf)))), WRONG_PASSWORD_CODE);
});

check('newVault: two calls give different vaultIds', () => {
  const a = JSON.parse(api.parseHeader(api.newVault('a-new-master-password')));
  const b = JSON.parse(api.parseHeader(api.newVault('a-new-master-password')));
  notStrictEqual(a.vaultId, b.vaultId);
});

check('newVault: empty or too short password -> master_password_too_short', () => {
  strictEqual(errorCodeOf(() => api.newVault('')), 'master_password_too_short');
  strictEqual(errorCodeOf(() => api.newVault('short')), 'master_password_too_short');
});

check('defaultKdfParams: fresh salt each call, within bounds, derives a 32-byte key', () => {
  const a = JSON.parse(api.defaultKdfParams());
  const b = JSON.parse(api.defaultKdfParams());
  strictEqual(a.algorithm, 'Argon2id');
  notStrictEqual(a.salt, b.salt);
  api.checkKdfBounds(JSON.stringify(a));
  strictEqual(api.deriveKey('a-new-master-password', JSON.stringify(a)).length, 32);
});

check('validatePassword: accepts 8+ chars, rejects shorter with master_password_too_short', () => {
  api.validatePassword('12345678');
  strictEqual(errorCodeOf(() => api.validatePassword('1234567')), 'master_password_too_short');
  strictEqual(errorCodeOf(() => api.validatePassword('')), 'master_password_too_short');
});

check('parseHeader: malformed envelope -> vault_file_invalid', () => {
  strictEqual(errorCodeOf(() => api.parseHeader('{not json')), 'vault_file_invalid');
  strictEqual(errorCodeOf(() => api.parseHeader('{}')), 'vault_file_invalid');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
