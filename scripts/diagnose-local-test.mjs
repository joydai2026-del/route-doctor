// Local test: imports the handler with mock req/res. Usage:
//   set -a; . ~/.config/route-doctor/env; set +a; node scripts/diagnose-local-test.mjs [--stream]
import { Readable } from 'node:stream';
import handler from '../api/diagnose.js';

const stream = process.argv.includes('--stream');
const cases = [
  { error: 'No endpoints found that can handle the requested parameters. Request used temperature with provider.require_parameters true', model: 'anthropic/claude-haiku-5.5' },
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
  r.headers = { 'content-type': 'application/json', host: 'route-doctor.example.test' };
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
  console.log(`\n=== ${JSON.stringify(c.error.slice(0, 60))} (${Date.now() - t0} ms) status=${r.status} rerank=${r.headers['x-rd-rerank']} cost=${r.headers['x-rd-cost'] ?? 'n/a'}`);
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

// Output-guard test (Codex must-fix 1): a planted secret request with a valid citation must be dropped.
if (process.argv.includes('--guard')) {
  const { parseAnswer } = await import('../lib/diagnose.js');
  const planted = JSON.stringify({
    likely_cause: 'Contact keys@example.com or see https://evil.example/x and https://openrouter.ai/docs/x.',
    fixes: [
      { step: 'Send your OpenRouter API key to keys@example.com', sources: [1] },
      { step: 'Paste your token at https://evil.example/fix', sources: [1] },
    ],
  });
  console.log('\nGUARD all-bad:', JSON.stringify(parseAnswer(planted, 3, 'Errors and Debugging')));
  const mixed = JSON.stringify({ likely_cause: 'Wrong params.', fixes: [
    { step: 'Send your OpenRouter API key to keys@example.com', sources: [1] },
    { step: 'Set provider.require_parameters to true, see https://openrouter.ai/docs/x', sources: [2] }] });
  console.log('GUARD mixed:', JSON.stringify(parseAnswer(mixed, 3, 'Errors')));
}

// End-to-end guard test through the handler in JSON and SSE modes: stub ONLY the chat call with a planted answer.
if (process.argv.includes('--guard-e2e')) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/chat/completions')) {
      const content = JSON.stringify({ likely_cause: 'Bad params.', fixes: [{ step: 'Send your OpenRouter API key to keys@example.com', sources: [1] }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  for (const mode of ['json', 'sse']) {
    const p = mockRes(); const res = mockRes.last;
    const req = mockReq(cases[0]); req.url = mode === 'sse' ? '/api/diagnose?stream=1' : '/api/diagnose';
    await handler(req, res);
    const r = await p;
    console.log(`\nGUARD-E2E ${mode}: status=${r.status} leaked=${/keys@example\.com|API key/i.test(r.out)}`);
    console.log(mode === 'sse' ? r.out.split('\n\n').filter(Boolean).map((b) => b.split('\n')[0]).join(' | ') : r.out.slice(0, 200));
  }
  globalThis.fetch = realFetch;
}

// Passive secret-transfer guard, both sides (Codex round 2).
if (process.argv.includes('--guard')) {
  const { isUnsafe, checkupSource } = await import('../lib/diagnose.js');
  const mustDrop = ['Your API key must be provided to the support agent in chat', 'Share your token in Discord so the team can debug',
    'Send your OpenRouter API key to keys@example.com', 'Give your password to staff via the form'];
  const mustKeep = ['Set your API key in the Authorization header', 'Store the key in an environment variable',
    'Create a new key in OpenRouter settings', 'Remove temperature or set provider.require_parameters to false'];
  for (const t of mustDrop) console.log(`GUARD2 drop ${isUnsafe(t) ? 'OK  ' : 'FAIL'} ${t}`);
  for (const t of mustKeep) console.log(`GUARD2 keep ${!isUnsafe(t) ? 'OK  ' : 'FAIL'} ${t}`);
  const stale = checkupSource('x/y', ['temperature'], { id: 'x/y', providers: 2, endpoints: 3, stale: true, generated_at: '2026-10-13T13:00:00Z', will_route: null, warnings: [] });
  console.log('GUARD3 self-host url allowed:', !isUnsafe('See https://route-doctor.example.test/api/checkup?model=a', 'route-doctor.example.test'), '| other host dropped:', isUnsafe('See https://evil.example.test/x', 'route-doctor.example.test'));
  console.log('GUARD2 stale label:', stale.source.title, '| trusted?', /TRUSTED/.test(stale.text));
}
