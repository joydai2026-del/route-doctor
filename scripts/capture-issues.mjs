// Capture ~50 GitHub issues about OpenRouter routing/provider errors via authenticated `gh`.
// Usernames and @mentions are stripped; author logins are never stored.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64e6 }));
const PHRASES = ['"No endpoints found"', '"Provider returned error"', '"empty content" max_tokens reasoning', 'json_schema', '"No allowed providers"', 'data_collection', '"data policy"'];
const MUST = ['openstory-so/openstory#1317','agent0ai/agent-zero#1255','earendil-works/pi#2204','langchain-ai/langchain#36067','thedotmack/claude-mem#2995','simonw/llm-openrouter#45','anomalyco/opencode#5773','anomalyco/opencode#1002'];
const clean = (s, n) => (s || '').replace(/@[A-Za-z0-9][A-Za-z0-9-]*/g, '@user').replace(/\r/g, '').slice(0, n);
const seen = new Map();
async function fetchIssue(repo, num) {
  const key = `${repo}#${num}`;
  if (seen.has(key)) return;
  try {
    const i = gh(['api', `repos/${repo}/issues/${num}`]);
    let comments = [];
    if (i.comments > 0) comments = gh(['api', `repos/${repo}/issues/${num}/comments?per_page=3`]).slice(0, 3).map(c => clean(c.body, 1500));
    seen.set(key, { source_type: 'issue', url: i.html_url, title: clean(i.title, 300), content: '', body: clean(i.body, 4000), comments });
  } catch (e) { console.error('skip', key, String(e.message).split('\n')[0]); }
}
for (const m of MUST) { const [repo, n] = m.split('#'); await fetchIssue(repo, n); }
const mustCount = seen.size;
const perPhrase = Math.ceil((50 - mustCount) / PHRASES.length) + 2;
const hits = PHRASES.map(p => {
  try { return gh(['api', '-X', 'GET', 'search/issues', '-f', `q=openrouter ${p} is:issue`, '-f', 'sort=reactions-interactions', '-f', 'per_page=30']).items; }
  catch (e) { console.error('search fail', p); return []; }
});
for (let round = 0; seen.size < 50 && round < 30; round++) {
  for (const items of hits) {
    const it = items[round]; if (!it || seen.size >= 50) continue;
    const repo = it.repository_url.replace('https://api.github.com/repos/', '');
    await fetchIssue(repo, it.number);
  }
}
const rows = [...seen.values()].map(r => {
  const content = `${r.title}\n\n${r.body}` + r.comments.map((c, i) => `\n\nComment ${i + 1}: ${c}`).join('');
  return { source_type: 'issue', url: r.url, title: r.title, content };
});
mkdirSync('scripts/corpus', { recursive: true });
writeFileSync('scripts/corpus/issues.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`issues=${rows.length} (must-include fetched: ${mustCount}/${MUST.length})`);
