// POST /api/diagnose (contract: docs/api-contract.md).
// JSON by default; Server-Sent Events when ?stream=1 or Accept: text/event-stream.
//
// Streaming choice: the model is asked for strict JSON in both modes, and in stream mode we forward that
// raw JSON text as `delta` events as it arrives, then send the parsed, validated object in `done`.
// Why: one prompt and one parser for both modes (no second "prose" prompt to keep in sync), and the
// page treats `done` as the source of truth, so a malformed stream never corrupts the final answer.
import { diagnose, HttpError } from '../lib/diagnose.js';

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null;
  if (raw === null) {
    raw = '';
    for await (const c of req) { raw += c; if (raw.length > 64_000) throw new HttpError(413, { error: 'too_large' }); }
  }
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
  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const input = await readBody(req);
    const hooks = stream ? {
      stream: true,
      onSources(sources, rerankPath) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('x-rd-rerank', rerankPath);
        started = true;
        sse('sources', sources);
      },
      onDelta(text) { sse('delta', { text }); },
    } : {};

    const out = await diagnose(input, hooks);
    if (stream) {
      sse('done', out.body);
      return res.end();
    }
    return sendJson(res, 200, out.body, { 'x-rd-rerank': out.rerank, 'x-rd-cost': String(out.cost) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const body = e instanceof HttpError ? e.body : { error: 'internal_error', message: 'Something went wrong. Try again.' };
    if (!(e instanceof HttpError)) console.error('diagnose failed:', e?.message);
    if (stream && started) { sse('error', { status, ...body }); return res.end(); }
    return sendJson(res, status, body);
  }
}
