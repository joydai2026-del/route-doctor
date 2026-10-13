// Local check for /api/checkup with mock req/res (live OpenRouter calls, no server).
// Usage: node scripts/checkup-local-test.mjs [--write-snapshot]
import { writeFile } from 'node:fs/promises';
import handler from '../api/checkup.js';
import { buildFreshSnapshot } from '../lib/checkup.js';

async function call(path) {
  const headers = {};
  let body = '';
  const res = { statusCode: 200, setHeader: (k, v) => (headers[k.toLowerCase()] = v), end: (b) => (body = b) };
  await handler({ method: 'GET', url: path }, res);
  return { status: res.statusCode, headers, json: JSON.parse(body) };
}

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) fails++;
};

if (process.argv.includes('--write-snapshot')) {
  const t = Date.now();
  const snap = await buildFreshSnapshot();
  await writeFile(new URL('../lib/snapshot.json', import.meta.url), JSON.stringify(snap));
  console.log(`snapshot written in ${Date.now() - t} ms`, snap.totals);
}

let t = Date.now();
let r = await call('/api/checkup?model=google/gemini-3.8-flash&params=temperature');
const gt = Date.now() - t;
check('gemini 6 endpoints / 2 providers', r.json.endpoints === 6 && r.json.providers === 2, `${r.json.endpoints}/${r.json.providers} in ${gt} ms`);
check('gemini temperature 3 of 6', r.json.param_support?.temperature?.endpoints === 3 && r.json.param_support.temperature.of === 6, JSON.stringify(r.json.param_support?.temperature));
check('gemini always_reasons', r.json.warnings.some((w) => w.code === 'always_reasons'));
check('gemini cache header', r.headers['cache-control'] === 's-maxage=300, stale-while-revalidate=600');

r = await call('/api/checkup?model=anthropic/claude-haiku-5.5&params=temperature');
check('haiku 10 endpoints / 5 providers', r.json.endpoints === 10 && r.json.providers === 5, `${r.json.endpoints}/${r.json.providers}`);
check('haiku temperature -> will_route false + no_route', r.json.will_route === false && r.json.warnings.some((w) => w.code === 'no_route'));

r = await call('/api/checkup?model=deepseek/deepseek-v4.1-flash');
check('deepseek 32 endpoints / 29 providers', r.json.endpoints === 32 && r.json.providers === 29, `${r.json.endpoints}/${r.json.providers}`);

r = await call('/api/checkup?model=google/gemini-flash-nope');
check('unknown -> 404 with suggestions', r.status === 404 && r.json.error === 'model_not_found' && r.json.suggestions.length > 0, JSON.stringify(r.json.suggestions));

r = await call('/api/checkup?simulate_down=1');
check('simulate_down summary stale + notice + no-store', r.json.stale === true && /last good copy/.test(r.json.notice) && r.headers['cache-control'] === 'no-store', r.json.notice);

r = await call('/api/checkup?model=google/gemini-3.8-flash&simulate_down=1');
check('simulate_down single model stale', r.status === 200 && r.json.stale === true && r.headers['cache-control'] === 'no-store');

t = Date.now();
r = await call('/api/checkup');
check('full snapshot live', r.status === 200 && r.json.stale === false && r.json.models.length > 300 && r.json.totals.unavailable === 0 && !r.json.models.some((m) => m.id.startsWith('~')), `${Date.now() - t} ms totals=${JSON.stringify(r.json.totals)}`);
check('every warning has message + fix', r.json.models.every((m) => m.warnings.every((w) => w.message && w.fix)));
console.log('riskiest 3:', r.json.models.slice(0, 3).map((m) => `${m.id} (${m.warnings.map((w) => w.code).join(',')})`).join(' | '));


r = await call('/api/checkup?model=anthropic/claude-haiku-5.5&params=temperature&simulate_down=1');
check('stale + params -> will_route null + unverified', r.json.will_route === null && r.json.supporting_endpoints === null && r.json.requested_params[0] === 'temperature' && r.json.warnings.some((w) => w.code === 'unverified'));
r = await call('/api/checkup?model=brand-new/not-in-snapshot&simulate_down=1');
check('stale + absent -> 503 unavailable', r.status === 503 && r.json.error === 'unavailable' && r.json.stale === true && !!r.json.notice);
r = await call('/api/checkup?model=deepseek/deepseek-v4.1-flash:nitro');
check(':nitro resolves to base with variant', r.status === 200 && r.json.variant === 'nitro' && r.json.id === 'deepseek/deepseek-v4.1-flash', `${r.status} ${r.json.id}`);
r = await call('/api/checkup?model=openrouter/auto');
check('router -> router:true will_route null no one_company', r.status === 200 && r.json.router === true && r.json.will_route === null && !r.json.warnings.some((w) => w.code === 'one_company'), `${r.status}`);
r = await call('/api/checkup?model=google/gemini-3.8-flash&params=' + Array.from({ length: 21 }, (_, i) => 'p' + i).join(','));
check('21 params -> 400 too_many_params', r.status === 400 && r.json.error === 'too_many_params');
r = await call('/api/checkup?model=google/gemini-3.8-flash&params=' + Array(30).fill('max_tokens').join(',') + ',temperature');
check('30 dup params dedupe, temperature kept', r.status === 200 && r.json.requested_params.includes('temperature') && r.json.requested_params.length === 2);

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
