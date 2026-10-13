# Route Doctor

Checkup before you build. Diagnosis when it breaks. A small helper for developers using OpenRouter.

Live: https://route-doctor.vercel.app

Unofficial, community-built, not affiliated with OpenRouter.

## The pain

In my own projects, picking the right model on OpenRouter took detours. The docs are helpful, but they don't give a straight answer on what to check before choosing a model, so I went back and forth: a setting one provider supports and another doesn't, a model with no backup provider, an error like 'No endpoints found' that doesn't say why. I wanted one place that gives direct answers. It isn't just me: searching GitHub for that error turns up more than 450 issues across nearly 300 repositories ([search](https://github.com/search?q=%22No+endpoints+found%22+openrouter&type=issues)).

(Issue count re-checked 2026-10-13 09:58 ET with the GitHub search API: 468 issues, up from 467 on 2026-10-12. The repository count was not re-measured.)

## What it does

| Part | Question it answers | How | AI? |
|---|---|---|---|
| **Checkup** | "Will this exact request route, and what is the backup?" | Reads OpenRouter's live model and endpoint lists, cached 5 minutes | None. Plain code. |
| **Diagnosis** | "Why did this break, and how do I fix it?" | Searches OpenRouter's docs plus 50 public GitHub issues, answers with numbered sources | Yes (RAG: retrieve, rerank, write a cited answer) |

**Agent-first.** The JSON API is the product. The web page calls the same API, so one test set covers both. Agents find usage instructions at [`/llms.txt`](https://route-doctor.vercel.app/llms.txt). Full contract: `docs/api-contract.md`.

```bash
curl -s "https://route-doctor.vercel.app/api/checkup?model=google/gemini-3.8-flash&params=temperature"

curl -s -X POST "https://route-doctor.vercel.app/api/diagnose" \
  -H "Content-Type: application/json" \
  -d '{"error": "No endpoints found that support the requested parameters", "model": "google/gemini-3.8-flash"}'
```

## Why this approach

| Choice | Why |
|---|---|
| Checkup uses no AI | The questions ("does any provider support `temperature` for this model?") have exact answers in published data. Code is free, fast and never guesses. |
| Diagnosis uses RAG with citations | Error messages are vague. The real fixes live in docs pages and other developers' GitHub threads. Every fix points to its source so you can check it. |
| Honest `covered: false` | When nothing relevant is found, it says so instead of inventing an answer. |
| API first, page second | Developers increasingly debug through coding agents. An agent given only the URL can use it (tested, see V6). |

**Why not OpenRouter's official MCP?** It already has `list-model-endpoints` and `search-docs`. Route Doctor adds three things on top: a verdict on your exact request (will these parameters route, and how many backup providers support them), community fixes from GitHub issues (not only docs), and an honest `covered: false` when it does not know.

## Technical choices

| Area | Choice | Why |
|---|---|---|
| Data source | OpenRouter `/models` plus each model's endpoint list, fetched live | Published data is the ground truth for routing |
| Freshness | 5-minute CDN cache (`s-maxage`), last good copy served with a notice if OpenRouter is down, `?simulate_down=1` to prove it | Every view is at most 5 minutes old and shows its timestamp |
| Unknown is a valid answer | During an outage with `params`, routing fields become `null` plus an `unverified` warning, never a confident guess | From the Codex review: say unknown, not wrong |
| Counting rule | Failover counts distinct `provider_name`, not endpoints | Six endpoints from one company is still one company. Snapshot 2026-10-13 09:54 ET: 367 text models (excluding `:batch` and `~` aliases); 211 depend on one company, of which 174 have a single endpoint and 37 have several endpoints from the same company. |
| Other live totals (same snapshot) | 145 list a parameter not every provider supports; 81 always reason; 6 are routers (`openrouter/*`, not risk-scored) | |
| Embeddings | `baai/bge-m3` | 1024 dimensions fit a pgvector HNSW index in Supabase |
| Rerank | `qwen/qwen3-reranker-8b`, 4-second timeout, falls back to vector order | It has one provider and returned 503 during the build, so the fallback is required |
| Answer model | `deepseek/deepseek-v4.1-flash`, with `models` fallback to `openai/gpt-4.1-mini` | Cheap and fast; the fallback uses OpenRouter's own `models` array |
| Answer settings | Reasoning off, `max_tokens` 700 | Reasoning tokens can eat the budget and return an empty answer (one of my own bugs) |
| Privacy | `provider.data_collection: "deny"` on every embed, rerank and chat call | Pasted errors may contain private details |
| Streaming | Progress-stage server-sent events (searching, reranking, writing), then the validated JSON | The security review showed streaming raw model text would show users unvalidated output before the guard runs |
| Output guard | Answers are checked before they leave the server; unsafe fixes are dropped and marked `guarded: true` | Retrieved issues are untrusted text and could carry planted instructions |
| Checkup as source [0] | When a model is given, the live checkup is a trusted source and the first fix must address it | Found by the V6 agent test |

## Verification

Live runs against https://route-doctor.vercel.app, 2026-10-13 (latest automated run 09:58 ET).

| # | Claim | Result |
|---|---|---|
| V1 | Checkup is correct | 6/6 golden models (from my own bugs) pass; unknown model returns 404 `model_not_found`. Random-10 hand-check vs openrouter.ai: **PENDING (JJ)** |
| V2 | Fresh | Snapshot age 1s on first call; CDN returns `x-vercel-cache: HIT` with climbing age; outage path shows last good copy + notice, `no-store` |
| V3 | Retrieval finds the right source | 11/12 golden questions have the tagged source in the top 5 (95% Wilson range 65-99%) |
| V4 | Answers are grounded | Hand-check that each cited source contains the fix: **PENDING (JJ)** |
| V5 | Honest gaps | 2/2 off-topic questions return `covered: false` |
| V6 | An agent can use it | A fresh Claude session given only the URL found `llms.txt`, called checkup then diagnose, and gave the right fix |
| V7 | Safe | A planted malicious issue was retrieved and its instruction was not obeyed; 2 Codex adversarial review rounds applied |
| V8 | Cost | **PENDING final number** |

## Built vs not built

| Built (this hour) | Phase 2 |
|---|---|
| Checkup API with exact-request verdicts | MCP server for agents, or contribute the checks to OpenRouter's official MCP |
| Diagnosis API with cited answers and `covered: false` | Per-IP rate limit and a spend cap that reserves cost before each call |
| Web page on the same API, `llms.txt` | Context length, max output and quantization checks |
| Golden tests written before the code | Real probe calls per provider (live behavior, not only published data) |
| Output guard, data-collection deny | Merged pull requests as confirmed fixes |
| | Weekly docs-gap report built from logged `covered: false` questions |

## Not yet verified

- Accuracy at scale: n=12 and n=10 give wide Wilson ranges; there is no large eval set.
- Answer quality beyond grounding (is the fix the best fix?); no expert panel.
- Live provider behavior (rate limits, outages, a provider that claims JSON support but fails). Checkup reads published data only.
- Freshness of the GitHub issue corpus after build day, and coverage beyond the roughly 5 error phrases captured.
- Prompt-injection resistance beyond one planted case.
- Load and abuse: no per-IP limit, no concurrency test.
- Agent usability beyond one agent (Claude); not tested with other agent frameworks.
- Codex review was 2 rounds, not the full no-cap loop.

## Timeline

| Phase | What happened |
|---|---|
| Pre-clock setup (before 09:40 ET) | Vercel project linked to the repo (push to `main` deploys), env vars set in Vercel, Supabase project chosen (tables prefixed `rd_`), OpenRouter key with a $10 hard limit, empty folder skeleton (commit `82f26c5`) |
| Build | Start commit `a1014a3` at 2026-10-13 09:40:43 ET. End: END_TIME_PENDING |

Commits land every few minutes and are never squashed, so `git log` is the build record.

## Cost

PENDING final number (OpenRouter key usage for build plus QA).

## Learnings (written by JJ)

_(placeholder)_

## Run it yourself

Zero npm dependencies. Node 22.

| Step | Command |
|---|---|
| 1. Env vars | `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (optional overrides: `RD_EMBED_MODEL`, `RD_RERANK_MODEL`, `RD_ANSWER_MODELS`, `RD_MAX_TOKENS`) |
| 2. Database | Run `scripts/schema.sql` in Supabase (pgvector table + match function) |
| 3. Capture corpus | `node scripts/capture-docs.mjs` and `node scripts/capture-issues.mjs` (needs an authenticated `gh`) |
| 4. Embed and store | `node scripts/embed-and-store.mjs` |
| 5. Local server | `node scripts/dev-server.mjs` |
| 6. Tests | `BASE=http://localhost:3000 node tests/run-golden.mjs` (or point `BASE` at the live URL) |
