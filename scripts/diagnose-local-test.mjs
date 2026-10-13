// Local test: imports the handler with mock req/res. Usage:
//   set -a; . ~/.config/route-doctor/env; set +a; node scripts/diagnose-local-test.mjs [--stream]
import { Readable } from 'node:stream';
import handler from '../api/diagnose.js';

const stream = process.argv.includes('--stream');
const cases = [
  { error: 'No endpoints found that can handle the requested parameters', model: 'deepseek/deepseek-v4.1-flash' },
  { error: 'My answer came back empty' },
  { error: 'Write me a poem about autumn' },
  { error: 'What is the best pizza in Naples?' },
  { error: '' },
];

function mockReq(body) {
  const r = Readable.from([JSON.stringify(body)]);
  r.method = 'POST';
  r.url = stream ? '/api/diagnose?stream=1' : '/api/diagnose';
  r.headers = { 'content-type': 'application/json' };
  return r;
}

function mockRes() {
  const headers = {}; let out = '';
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      write: (s) => { out += s; return true; },
      end: (s) => { if (s) out += s; resolve({ status: res.statusCode, headers, out }); },
    };
    resolve.res = res;
    mockRes.last = res;
  });
}

for (const c of (process.argv.includes('--one') ? cases.slice(0, 1) : cases)) {
  const p = mockRes();
  const t0 = Date.now();
  await handler(mockReq(c), mockRes.last);
  const r = await p;
  console.log(`\n=== ${JSON.stringify(c.error)} (${Date.now() - t0} ms) status=${r.status} rerank=${r.headers['x-rd-rerank']} cost=${r.headers['x-rd-cost'] ?? 'n/a'}`);
  if (stream) {
    const events = r.out.split('\n\n').filter(Boolean).map((b) => b.split('\n')[0]);
    console.log('events:', events.reduce((m, e) => ((m[e] = (m[e] || 0) + 1), m), {}));
    console.log(r.out.split('\n\n').filter((b) => b.startsWith('event: done')).join('').slice(0, 1500));
  } else {
    const j = JSON.parse(r.out);
    if (j.checkup) j.checkup = { id: j.checkup.id, warnings: (j.checkup.warnings || []).map((w) => w.code) };
    console.log(JSON.stringify(j, null, 1).slice(0, 2500));
  }
}
