// Static server for the Phase 0 spike. No dependencies.
//   node serve.mjs            -> http://0.0.0.0:8787
// Serves web-spike/ at / and ../fixtures at /fixtures/. POST /results writes the
// body to results/<timestamp>-<short-ua>.json and prints the file name.

import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const HOST = '0.0.0.0';
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const FIXTURES = resolve(ROOT, '..', 'fixtures');
const RESULTS = join(ROOT, 'results');
const MAX_BODY = 5 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.pdvault': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Which file a URL path maps to, or null when it escapes the served roots.
function resolvePath(pathname) {
  let base = ROOT;
  let rel = pathname;
  if (pathname.startsWith('/fixtures/')) {
    base = FIXTURES;
    rel = pathname.slice('/fixtures'.length);
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(base, '.' + normalize(rel));
  if (file !== base && !file.startsWith(base + sep)) return null;
  // Never serve captured results, dependencies or build scratch space.
  if (base === ROOT && /^[\\/](results|node_modules)[\\/]/.test(file.slice(ROOT.length))) return null;
  return file;
}

// "Chrome-130-Android", "Firefox-132-Windows", ... short and filename-safe.
function shortUa(ua = '') {
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0].replace('/', '-') ||
    /Firefox\/(\d+)/.exec(ua)?.[0].replace('/', '-') ||
    (/Chrome\/(\d+)/.exec(ua) && 'Chrome-' + /Chrome\/(\d+)/.exec(ua)[1]) ||
    (/Version\/(\d+)[\d.]* .*Safari/.exec(ua) && 'Safari-' + /Version\/(\d+)/.exec(ua)[1]) ||
    'unknown';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'os';
  return `${browser}-${os}`.replace(/[^A-Za-z0-9._-]/g, '');
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST' && url.pathname === '/results') {
      const body = await readBody(req);
      let json;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        return send(400, 'invalid json');
      }
      await mkdir(RESULTS, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `${stamp}-${shortUa(json?.env?.userAgent || req.headers['user-agent'])}.json`;
      await writeFile(join(RESULTS, name), JSON.stringify(json, null, 2));
      console.log('results saved:', join('results', name));
      return send(200, name);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');

    const file = resolvePath(decodeURIComponent(url.pathname));
    if (!file) return send(403, 'forbidden');
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) return send(404, 'not found: ' + url.pathname);
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (err) {
    console.error('request failed:', err);
    send(500, 'server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Passdroid Phase 0 spike server on http://${HOST}:${PORT}`);
  console.log(`  this machine:  http://localhost:${PORT}/`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  on the LAN:    http://${a.address}:${PORT}/`);
    }
  }
});
