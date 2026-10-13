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
| Freshness | CDN cache with `s-maxage` = what is left of a 300-second lifetime, plus `stale-while-revalidate` 60 seconds, so the oldest copy anyone sees is about 6 minutes old. The page shows the exact age from `generated_at`. If OpenRouter is down, the last good copy is served with a notice; `?simulate_down=1` proves it | One refresh per few minutes for OpenRouter, a visible timestamp for users |
| Unknown is a valid answer | During an outage with `params`, routing fields become `null` plus an `unverified` warning, never a confident guess | From the Codex review: say unknown, not wrong |
| Counting rule | Failover counts distinct `provider_name` exactly as OpenRouter lists them, not endpoints. Google AI Studio and Google Vertex count as two. The label says "one provider" | Six endpoints from one provider is still no backup. Live 2026-10-13 10:07 ET: 367 text models (excluding `:batch` and `~` aliases); 211 depend on one provider, of which 174 have a single endpoint and 37 have several endpoints from that same provider |
| Six checks (same live data) | Param mismatch (145 models), always reasons (81), limit mismatch: context or output limits differ across providers (87), provider down: OpenRouter reports 0% uptime over both 30 minutes and 5 minutes (11). 6 routers (`openrouter/*`) are not risk-scored | Limit mismatch and provider down were added during the build; the V1 random-10 check surfaced Nova Premier at 0% uptime |
| Uptime, not `status` | Provider down uses uptime only | The undocumented endpoint `status` field showed -2 on 53 healthy endpoints, so it is not trusted |
| Corpus | OpenRouter docs (`llms-full.txt`) plus 50 GitHub issues, captured once on 2026-10-13 09:46 ET | Scheduled re-capture is Phase 2 |
| Embeddings | `baai/bge-m3` | 1024 dimensions fit a pgvector HNSW index in Supabase |
| Rerank | `qwen/qwen3-reranker-8b`, 4-second timeout, falls back to vector order | It has one provider and returned 503 during the build, so the fallback is required |
| Answer model | `deepseek/deepseek-v4.1-flash`, with `models` fallback to `openai/gpt-4.1-mini` | Cheap and fast; the fallback uses OpenRouter's own `models` array |
| Answer settings | Reasoning off, `max_tokens` 700 | Reasoning tokens can eat the budget and return an empty answer (one of my own bugs) |
| Privacy | `provider.data_collection: "deny"` on every embed, rerank and chat call | Pasted errors may contain private details |
| Streaming | Progress-stage server-sent events (searching, reranking, writing), then the validated JSON | The security review showed streaming raw model text would show users unvalidated output before the guard runs |
| Output guard | Answers are checked before they leave the server; unsafe fixes are dropped and marked `guarded: true` | Retrieved issues are untrusted text and could carry planted instructions |
| Checkup as source [0] | When a model is given, the live checkup is a trusted source and the first fix must address it | The V6 agent test showed diagnose was ignoring its own checkup data |

## Verification

Live runs against https://route-doctor.vercel.app, 2026-10-13.

| # | Claim | Result |
|---|---|---|
| V1 | Checkup is correct | 6/6 golden models (from my own bugs) pass; unknown model returns 404 `model_not_found`. Random-10 check vs openrouter.ai, model-graded by GPT-6.1 Sol (different model family, not a human): 10/10 (95% Wilson 72-100%), details in `docs/verification-v1-handcheck.md`. It surfaced Nova Premier at 0% uptime, which led to the provider-down check |
| V2 | Fresh | Three GETs of `/api/checkup` returned `x-vercel-cache: HIT` with age 121, 123, 125 s; outage path shows the last good copy + notice, `no-store` |
| V3 | Retrieval finds the right source | 11/12 golden questions have the tagged source in the top 5 (95% Wilson 65-99%). Miss: Q2 "empty content" (the reasoning-tokens page was not in its top 5) |
| V4 | Answers are grounded | Model-graded by GPT-6.1 Sol (different model family), not a human: **29/45 fixes supported by their cited source (95% Wilson 50-77%)**, 5/12 questions fully supported, **0 fabricated links**. Failure = overconfidence and lost conditions; fixes now labeled documented vs reported workaround and phrased conditionally (not re-graded yet). [Details](docs/verification-v4-grounding.md) |
| V5 | Honest gaps | 2/2 off-topic questions return `covered: false` |
| V6 | An agent can use it | A fresh Claude session given only the URL read `llms.txt`, called checkup then diagnose, and gave the right fix. It also exposed that diagnose ignored its own checkup data, now fixed (source [0]) |
| V7 | Safe | A planted malicious issue was retrieved and its instruction was not obeyed. 3 Codex adversarial rounds plus 1 fresh Claude review; fixed findings included raw streaming before validation, an injection surviving through a citation, and stale data shown as a confident verdict |
| V8 | Cost | **$0.39** total OpenRouter spend for build, all test runs and reviews (key hard limit $10) |

## Built vs not built

| Built (this hour) | Phase 2 |
|---|---|
| Checkup API with exact-request verdicts | MCP server for agents, or contribute the checks to OpenRouter's official MCP (we chose the limit check over MCP for this hour) |
| Diagnosis API with cited answers and `covered: false` | Per-IP rate limit and a spend cap that reserves cost before each call |
| Web page on the same API, `llms.txt` | Quantization checks |
| Limit-mismatch and provider-down checks | Real probe calls per provider (live behavior, not only published data) |
| Golden tests written before the code | Merged pull requests as confirmed fixes |
| Output guard, data-collection deny | Scheduled re-capture: issues daily, docs weekly (see below) |
| | Weekly docs-gap report built from logged `covered: false` questions |

**Why the corpus is not refreshed yet.** Model data is live (5-minute cache), but the docs and GitHub issues the Diagnosis box searches were captured once. A scheduled refresh is feasible, and it was left out for time, not for a technical limit. The scripts already exist; what is missing:

| Needed | Why | Estimate |
|---|---|---|
| A daily scheduler (GitHub Actions or Vercel cron) running the capture and embed scripts | Nothing runs them today | ~25 lines |
| Update in place instead of "delete all, then reload" | The current loader empties the table first, so each refresh would leave the Ask box with a partial corpus for about a minute | ~40-60 lines |
| A spend cap for the unattended job | It runs with nobody watching (cost is small: issues about $0.001 a day, re-embedding all docs about $0.02) | ~10 lines |
| Pinned golden issues and the planted test fixture | A refresh could drop the issues the golden tests expect | small |

Roughly 80-100 lines and 30-45 minutes including a review and one real scheduled run, which did not fit the hour.

## Not yet verified

- Accuracy at scale: n=12 and n=10 give wide Wilson ranges; there is no large eval set.
- Answer quality (is the fix the best fix?); no expert panel.
- Live provider behavior (rate limits, outages, a provider that claims JSON support but fails). Checkup reads published data only.
- Freshness of the GitHub issue corpus after build day, and coverage beyond the roughly 5 error phrases captured.
- Prompt-injection resistance beyond one planted case.
- Load and abuse: no per-IP limit, no concurrency test.
- Agent usability beyond one agent (Claude); not tested with other agent frameworks.
- Grounding (V4) was graded by another model, not a human, and not re-graded after the prompt change.
- Review depth: 3 Codex rounds and 1 Claude review, not the full no-cap loop.
- `provider_down` changes minute to minute (11 at 10:07 ET, 10 at 10:12 ET); README totals are a point-in-time snapshot, the API is the live number.

## Timeline

| Phase | What happened |
|---|---|
| Pre-clock setup (before 09:40 ET) | Vercel project linked to the repo (push to `main` deploys), env vars set in Vercel, Supabase project chosen (tables prefixed `rd_`), OpenRouter key with a $10 hard limit, empty folder skeleton (commit `82f26c5`) |
| Build | Start commit `a1014a3` at 2026-10-13 09:40:43 ET. End: final commit at about 10:28 ET (about 47 minutes). Post-build, README only: Learnings wording and an architecture diagram, no code changes |

Commits land every few minutes and are never squashed, so `git log` is the build record.

## Cost

**$0.39** of OpenRouter usage for the whole build and QA (embeddings about $0.016, about $0.002 per Diagnosis question). Supabase and Vercel on existing free or shared plans.

## Learnings (written by JJ)

1. **Ask how fresh each data source must be before designing, not after.** I asked "is the GitHub data refreshed every 5 minutes?" near the end of the build. The model data is live, but the docs and issues were captured once, and the loader wipes the table before reloading, so a scheduled refresh would have needed a different design from the start. Cadence decides the loader, the tests and the cost guard, so it belongs in the first questions.
2. **Grounded is not the same as correct.** A second model graded the answers: no fabricated links, yet only 29 of 45 fixes said what their source said. The failures were lost conditions and overconfidence, so every fix is now labeled "documented" or "reported workaround".
3. **Write the tests first, freeze them, and check the work against live sources and against other companies' models.** The golden tests were committed before any API code and compare our numbers to OpenRouter's raw data on every run, so a data change shows up as drift instead of hiding a bug. Review worked the same way: a model from a different company catches what the builder misses. Codex (OpenAI) found 19 must-fix issues across three review rounds in code and tests the Claude side had reported as done, and GPT-6.1 Sol (also a non-Anthropic model) found the overconfident answers.

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
