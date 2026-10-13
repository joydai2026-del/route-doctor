// Capture OpenRouter docs (llms-full.txt), split into pages, then ~1,500 char chunks.
// Approach adapted from supabase-community/nextjs-openai-doc-search generate-embeddings.ts (Apache-2.0).
import { writeFileSync, mkdirSync } from 'node:fs';
const SRC = 'https://openrouter.ai/docs/llms-full.txt';
const MAX = 1500;
const txt = await (await fetch(SRC)).text();
const lines = txt.split('\n');
const pages = [];
let cur = null, inFence = false;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^\s*```/.test(l)) inFence = !inFence;
  if (!inFence && /^# /.test(l) && /^Source: https:\/\/openrouter\.ai\/docs/.test(lines[i + 1] || '')) {
    cur = { title: l.slice(2).trim(), url: lines[i + 1].slice(8).trim(), body: [] };
    pages.push(cur); i++; continue;
  }
  if (cur) cur.body.push(l);
}
function split(body) {
  // paragraphs (blank-line separated, keeping fenced blocks intact), greedily packed
  const paras = []; let buf = [], fence = false;
  for (const l of body.split('\n')) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && l.trim() === '' && buf.length) { paras.push(buf.join('\n')); buf = []; }
    else buf.push(l);
  }
  if (buf.length) paras.push(buf.join('\n'));
  const out = []; let c = '';
  const flush = () => { if (c.trim()) out.push(c.trim()); c = ''; };
  for (let p of paras) {
    while (p.length > MAX) { // hard split oversized paragraph on line boundaries
      let cut = p.lastIndexOf('\n', MAX); if (cut < MAX / 2) cut = MAX;
      if (c) flush();
      out.push(p.slice(0, cut).trim()); p = p.slice(cut);
    }
    if (c && c.length + p.length + 2 > MAX) flush();
    // start new chunk at headings when chunk already decent
    if (c && /^#{1,4} /.test(p) && c.length > MAX / 2) flush();
    c += (c ? '\n\n' : '') + p;
  }
  flush();
  return out.filter(Boolean);
}
const rows = [];
for (const p of pages) {
  for (const ch of split(p.body.join('\n'))) {
    rows.push({ source_type: 'docs', url: p.url, title: p.title, content: `${p.title}\n\n${ch}` });
  }
}
mkdirSync('scripts/corpus', { recursive: true });
writeFileSync('scripts/corpus/docs.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`pages=${pages.length} chunks=${rows.length}`);
