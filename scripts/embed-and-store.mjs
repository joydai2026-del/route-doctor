// Embed corpus (docs + issues + planted fixture) with baai/bge-m3 via OpenRouter and load into Supabase rd_chunks.
// Idempotent: deletes all existing rows first. Approach: supabase-community/nextjs-openai-doc-search (Apache-2.0).
import { readFileSync } from 'node:fs';
const { SUPABASE_URL, SUPABASE_SECRET_KEY, OPENROUTER_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !OPENROUTER_API_KEY) throw new Error('missing env');
const sb = { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' };
const load = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rows = [...load('scripts/corpus/docs.jsonl'), ...load('scripts/corpus/issues.jsonl')];
const fx = readFileSync('tests/fixtures/planted-issue.md', 'utf8');
rows.push({ source_type: 'issue', url: 'https://github.com/joydai2026-del/route-doctor/blob/main/tests/fixtures/planted-issue.md',
  title: '[TEST FIXTURE] Planted prompt injection', content: fx });
console.log('rows to embed:', rows.length);

let tokens = 0, cost = 0;
async function embed(texts, attempt = 0) {
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'baai/bge-m3', input: texts.map(t => t.slice(0, 6000)), provider: { data_collection: 'deny' } }),
  });
  if (!r.ok) {
    if (attempt < 4) { await new Promise(s => setTimeout(s, 2000 * (attempt + 1))); return embed(texts, attempt + 1); }
    throw new Error(`embed ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  const j = await r.json();
  tokens += j.usage?.total_tokens ?? j.usage?.prompt_tokens ?? 0; cost += j.usage?.cost ?? 0;
  return j.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}
async function sbFetch(path, opts) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...sb, ...(opts?.headers || {}) } });
  if (!r.ok) throw new Error(`supabase ${path} ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}
// verify dims on first call
const first = await embed([rows[0].content]);
console.log('embedding dims:', first[0].length);
if (first[0].length !== 1024) throw new Error('expected 1024 dims');

await sbFetch('rd_chunks?id=gt.0', { method: 'DELETE' });
console.log('cleared rd_chunks');

const B = 64, queue = []; for (let i = 0; i < rows.length; i += B) queue.push(i);
let done = 0;
async function worker() {
  while (queue.length) {
    const i = queue.shift();
    const batch = rows.slice(i, i + B);
    const embs = await embed(batch.map(r => r.content));
    const recs = batch.map((r, k) => ({ source_type: r.source_type, url: r.url, title: r.title, content: r.content, embedding: JSON.stringify(embs[k]) }));
    for (let j = 0; j < recs.length; j += 100) {
      await sbFetch('rd_chunks', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(recs.slice(j, j + 100)) });
    }
    done += batch.length;
    if (done % 640 < B) console.log(`stored ${done}/${rows.length}`);
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(`DONE chunks=${done} tokens=${tokens} cost_usd=${cost || 'n/a'}`);
