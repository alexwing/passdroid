// Phase 0 benchmark: Argon2id in Rust-WASM (baseline + simd128) vs hash-wasm,
// plus the golden desktop/Android vault fixtures. Vanilla JS, no dependencies.

const PASSWORD = 'phase0-bench-password';
const SALT_B64 = btoa(String.fromCharCode(...Array.from({ length: 16 }, (_, i) => i)));
const GOLDEN_PASSWORD = 'phase0-golden-vectors';
const CONFIGS = [
  { label: '64 MiB t=3 p=1', m: 65536, t: 3, p: 1 },
  { label: '32 MiB t=3 p=1', m: 32768, t: 3, p: 1 },
];
const ENGINES = [
  { id: 'wasm', label: 'Rust-WASM' },
  { id: 'wasm-simd', label: 'Rust-WASM simd128' },
  { id: 'hash-wasm', label: 'hash-wasm' },
  { id: 'monocypher', label: 'Monocypher-WASM (Kindle)' },
];
// Only the Rust core exposes open/reseal; the other engines are KDF-only.
const VAULT_ENGINES = new Set(['wasm', 'wasm-simd']);
const FIXTURES = [
  { name: 'desktop-64mib', vault: 'fixtures/golden/desktop-64mib.pdvault', expected: 'fixtures/golden/expected-desktop.json' },
  { name: 'android-32mib', vault: 'fixtures/golden/android-32mib.pdvault', expected: 'fixtures/golden/expected-android.json' },
];
const OP_TIMEOUT_MS = 10 * 60 * 1000;

// Smallest module using a v128 op; validates only where simd128 is supported.
const simdSupported = WebAssembly.validate(
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
);

const $ = (id) => document.getElementById(id);
const fmt = (ms) => (ms == null ? '-' : ms.toFixed(0) + ' ms');
const mib = (bytes) => (bytes == null ? '-' : (bytes / 1048576).toFixed(0) + ' MiB');
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Fresh worker per test: an aborted wasm instance cannot be reused, and memory
// growth is then attributable to that test alone. Never rejects.
function call(engine, op, args) {
  return new Promise((resolve) => {
    const worker = new Worker('kdf.worker.js', { type: 'module' });
    const done = (value) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: { name: 'Timeout', message: 'no answer in ' + OP_TIMEOUT_MS / 1000 + ' s' } }),
      OP_TIMEOUT_MS,
    );
    worker.onerror = (e) => done({ ok: false, error: { name: 'WorkerError', message: e.message || 'worker failed to load/run' } });
    worker.onmessageerror = () => done({ ok: false, error: { name: 'MessageError', message: 'unserializable message' } });
    worker.onmessage = (ev) => {
      if (!ev.data.ok) return done(ev.data);
      const initMs = ev.data.initMs;
      worker.onmessage = (ev2) => done({ ...ev2.data, initMs });
      worker.postMessage({ id: 2, op, ...args });
    };
    worker.postMessage({ id: 1, op: 'init', engine });
  });
}

function setStatus(text) {
  $('status').textContent = text;
}

function renderEnv(env) {
  $('env').textContent = Object.entries(env)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}

function addRow(table, cells, cls) {
  const tr = document.createElement('tr');
  if (cls) tr.className = cls;
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.appendChild(td);
  }
  table.appendChild(tr);
}

async function runKdf(results) {
  const table = $('kdf');
  for (const cfg of CONFIGS) {
    const keysByEngine = {};
    for (const eng of ENGINES) {
      const entry = { engine: eng.id, config: cfg.label };
      results.kdf.push(entry);
      if (eng.id === 'wasm-simd' && !simdSupported) {
        entry.skipped = 'simd128 not supported by this browser';
        addRow(table, [cfg.label, eng.label, 'skipped (no simd128)', '', '', '', ''], 'skip');
        continue;
      }
      setStatus(`Argon2id ${cfg.label} - ${eng.label} (1 warm-up + 5 runs)...`);
      const r = await call(eng.id, 'kdf', { password: PASSWORD, saltB64: SALT_B64, m: cfg.m, t: cfg.t, p: cfg.p, runs: 5 });
      if (!r.ok) {
        entry.error = r.error;
        entry.memoryBytes = r.memoryBytes ?? null;
        addRow(table, [cfg.label, eng.label, `ERROR ${r.error.name}: ${r.error.message}`, '', '', '', ''], 'fail');
        continue;
      }
      entry.warmupMs = r.warmupMs;
      entry.runsMs = r.runsMs;
      entry.medianMs = median(r.runsMs);
      entry.minMs = Math.min(...r.runsMs);
      entry.maxMs = Math.max(...r.runsMs);
      entry.memoryBytes = r.memoryBytes;
      entry.initMs = r.initMs;
      entry.keyHex = r.keys[0];
      entry.stable = r.keys.every((k) => k === r.keys[0]);
      keysByEngine[eng.id] = r.keys[0];
      addRow(table, [cfg.label, eng.label, fmt(entry.medianMs), fmt(entry.minMs), fmt(entry.maxMs), fmt(entry.warmupMs), mib(entry.memoryBytes)]);
    }
    const keys = Object.values(keysByEngine);
    const identical =
      keys.length > 1 &&
      keys.every((k) => k === keys[0]) &&
      results.kdf.filter((e) => e.config === cfg.label && e.keyHex).every((e) => e.stable);
    results.identical[cfg.label] = { engines: Object.keys(keysByEngine), identical, key: keys[0] ?? null };
    addRow(table, [cfg.label, 'identical bytes?', identical ? 'YES' : 'NO', '', '', '', Object.keys(keysByEngine).join(', ')], identical ? 'pass' : 'fail');
  }
}

async function runGolden(results) {
  const table = $('golden');
  const files = {};
  for (const f of FIXTURES) {
    try {
      const [vault, expected] = await Promise.all([
        fetch(f.vault).then((r) => (r.ok ? r.text() : Promise.reject(new Error(f.vault + ' -> HTTP ' + r.status)))),
        fetch(f.expected).then((r) => (r.ok ? r.json() : Promise.reject(new Error(f.expected + ' -> HTTP ' + r.status)))),
      ]);
      files[f.name] = { vault, expected };
    } catch (e) {
      files[f.name] = { error: String(e.message || e) };
    }
  }
  for (const eng of ENGINES.filter((e) => VAULT_ENGINES.has(e.id))) {
    for (const f of FIXTURES) {
      const entry = { engine: eng.id, fixture: f.name };
      results.golden.push(entry);
      const file = files[f.name];
      if (file.error) {
        entry.error = { name: 'FetchError', message: file.error };
        addRow(table, [f.name, eng.label, 'ERROR ' + file.error, '', '', '', ''], 'fail');
        continue;
      }
      if (eng.id === 'wasm-simd' && !simdSupported) {
        entry.skipped = 'simd128 not supported by this browser';
        addRow(table, [f.name, eng.label, 'skipped (no simd128)', '', '', '', ''], 'skip');
        continue;
      }
      setStatus(`Golden ${f.name} - ${eng.label} (open, reseal, reopen, wrong password)...`);
      const r = await call(eng.id, 'golden', { vault: file.vault, expected: file.expected, password: GOLDEN_PASSWORD });
      if (!r.ok) {
        entry.error = r.error;
        addRow(table, [f.name, eng.label, `ERROR ${r.error.name}: ${r.error.message}`, '', '', '', ''], 'fail');
        continue;
      }
      Object.assign(entry, { pass: r.pass, kdf: r.kdf, steps: r.steps, memoryBytes: r.memoryBytes });
      const s = r.steps;
      const cell = (x) => `${x.pass ? 'ok' : 'FAIL'} ${fmt(x.ms)}`;
      addRow(table, [f.name, eng.label, r.pass ? 'PASS' : 'FAIL', cell(s.open), cell(s.reseal), cell(s.reopen), cell(s.wrongPassword)], r.pass ? 'pass' : 'fail');
    }
  }
}

async function main() {
  const nav = navigator;
  const results = {
    startedAt: new Date().toISOString(),
    env: {
      userAgent: nav.userAgent,
      hardwareConcurrency: nav.hardwareConcurrency ?? null,
      deviceMemory: nav.deviceMemory ?? null,
      crossOriginIsolated: self.crossOriginIsolated === true,
      isSecureContext: self.isSecureContext,
      simd128: simdSupported,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      platform: nav.userAgentData?.platform ?? nav.platform ?? null,
      mobile: nav.userAgentData?.mobile ?? null,
      page: location.href,
    },
    params: { password: PASSWORD, saltB64: SALT_B64, runs: '1 warm-up + 5 timed', output: 32 },
    kdf: [],
    identical: {},
    golden: [],
  };
  renderEnv(results.env);
  window.__benchResults = results;
  try {
    await runKdf(results);
    await runGolden(results);
  } catch (e) {
    results.fatal = String((e && e.stack) || e);
  }
  results.finishedAt = new Date().toISOString();
  results.allIdentical = Object.values(results.identical).every((x) => x.identical);
  results.allGoldenPass = results.golden.filter((g) => !g.skipped).every((g) => g.pass === true);
  results.done = true;
  setStatus('Done. Posting results...');
  try {
    const res = await fetch('results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(results) });
    setStatus(`Done. POST /results -> HTTP ${res.status}` + (res.ok ? ' (saved by serve.mjs)' : ''));
  } catch (e) {
    setStatus('Done. POST /results failed: ' + (e.message || e) + ' (copy window.__benchResults)');
  }
  $('raw').textContent = JSON.stringify(results, null, 2);
}

main();
