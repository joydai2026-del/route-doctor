// POST /api/diagnose (contract: docs/api-contract.md).
// JSON by default; Server-Sent Events when ?stream=1 or Accept: text/event-stream.
//
// Streaming choice (after Codex review): raw model text is NEVER streamed, because it has not yet passed the
// output guard (secret requests, emails, off-site links, usernames). SSE sends progress only:
// `status` {stage: searching|reranking|writing|checking}, `sources` as soon as retrieval finishes, then
// `done` with the validated, scrubbed JSON. The x-rd-rerank header is set when the stream opens, so in
// SSE mode it reflects the stage reached at that time; the same value also rides in `done` as `rerank`.
import { diagnose, HttpError } from '../lib/diagnose.js';

const MAX_BODY = 64_000;
const tooLarge = () => new HttpError(413, { error: 'too_large', message: 'Request is too large.' });

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (JSON.stringify(req.body).length > MAX_BODY) throw tooLarge();
    return req.body;
  }
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null;
  if (raw === null) {
    raw = '';
    for await (const c of req) { raw += c; if (raw.length > MAX_BODY) throw tooLarge(); }
  }
  if (raw.length > MAX_BODY) throw tooLarge();
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, { error: 'bad_json', message: 'Send JSON: {"error": "..."}' }); }
}

function wantsStream(req) {
  const q = (req.url || '').split('?')[1] || '';
  return new URLSearchParams(q).get('stream') === '1' || String(req.headers?.accept || '').includes('text/event-stream');
}

function sendJson(res, status, body, extra = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST.' });

  const stream = wantsStream(req);
  let started = false;
  let finished = false;
  const ac = new AbortController();
  // Client disconnect cancels all upstream work (no spending for a reader who left).
  res.on?.('close', () => { if (!finished) ac.abort(); });
  const open = (rerankPath) => {
    if (started) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (rerankPath) res.setHeader('x-rd-rerank', rerankPath);
    started = true;
  };
  const sse = (event, data) => { if (!ac.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  try {
    const input = await readBody(req);
    // Host for absolute self-links; re-validated in lib/diagnose.js (falls back to a relative path).
    const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
    const hooks = stream ? {
      host,
      signal: ac.signal,
      onStatus(stage) { open(); sse('status', { stage }); },
      onSources(sources, rerankPath) { open(rerankPath); sse('sources', sources); },
    } : { host, signal: ac.signal };

    const out = await diagnose(input, hooks);
    finished = true;
    if (stream) {
      open(out.rerank);
      sse('done', { ...out.body, rerank: out.rerank });
      return res.end();
    }
    return sendJson(res, 200, out.body, { 'x-rd-rerank': out.rerank, 'x-rd-cost': String(out.cost) });
  } catch (e) {
    finished = true;
    if (ac.signal.aborted) return res.end();
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const status = e instanceof HttpError ? e.status : timedOut ? 504 : 500;
    const body = e instanceof HttpError ? e.body : timedOut
      ? { error: 'timeout', message: 'That took too long. Try again.' }
      : { error: 'internal_error', message: 'Something went wrong. Try again.' };
    if (!(e instanceof HttpError)) console.error('diagnose failed:', e?.message);
    if (stream && started) { sse('error', { status, ...body }); return res.end(); }
    return sendJson(res, status, body);
  }
}
