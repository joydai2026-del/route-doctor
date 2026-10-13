// Zero-dependency local dev server that mimics Vercel: public/ as static root, /api/<name> -> api/<name>.js default export.
// Usage: set -a; . ~/.config/route-doctor/env; set +a; PORT=3000 node scripts/dev-server.mjs
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const API = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT || 3000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function shim(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (b) => {
    if (b !== null && typeof b === 'object' && !Buffer.isBuffer(b)) return res.json(b);
    res.end(b);
    return res;
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  if (String(req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end('Forbidden'); }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = url.pathname.match(/^\/api\/([a-z0-9_-]+)\/?$/i);
  if (!m) return serveStatic(res, url.pathname);
  const file = path.join(API, `${m[1]}.js`);
  try {
    await stat(file);
  } catch {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'not_found' }));
  }
  try {
    shim(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') req.body = await readBody(req);
    const mod = await import(pathToFileURL(file).href);
    await mod.default(req, res);
  } catch (err) {
    console.error(`[api/${m[1]}]`, err);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
    res.end(JSON.stringify({ error: 'internal' }));
  }
});

server.listen(PORT, () => console.log(`route-doctor dev server on http://localhost:${PORT}`));
