# API contract (locked at minute 6; page, tests and agents all use this)

Base: the deployed site root. No auth. JSON. Every OpenRouter call made by the server sends `provider: { data_collection: "deny" }`.

## GET /api/checkup

Without `model`: the dashboard summary.
```json
{
  "generated_at": "2026-10-13T13:45:00Z",
  "stale": false,                     // true when OpenRouter was unreachable and this is the last good copy
  "notice": null,                     // plain-English notice when stale
  "totals": {
    "models": 367,                    // text-output models, excluding ":batch"
    "one_company": 198,               // all endpoints from ONE provider_name (no real failover)
    "single_endpoint": 162,
    "param_mismatch": 90,             // a listed parameter not supported by every provider
    "always_reasons": 87              // reasoning cannot be turned off
  },
  "models": [ /* one ModelReport per model, sorted riskiest first */ ]
}
```

With `model=<id>` (and optional `params=temperature,response_format,...`): one ModelReport.
Unknown model: HTTP 404 `{ "error": "model_not_found", "model": "<id>", "suggestions": ["<close ids>"] }`.

### ModelReport
```json
{
  "id": "google/gemini-3.8-flash",
  "name": "Google: Gemini 3.8 Flash",
  "providers": 2,                      // distinct provider_name
  "endpoints": 6,
  "openrouter_url": "https://openrouter.ai/google/gemini-3.8-flash",
  "requested_params": ["temperature"], // echo of ?params (empty if none)
  "will_route": true,                  // with require_parameters:true, does ANY endpoint support all requested params
  "supporting_providers": 1,           // distinct provider_name supporting ALL requested params
  "supporting_endpoints": 3,
  "param_support": { "temperature": { "endpoints": 3, "of": 6 } },  // for every param the model lists
  "warnings": [
    { "code": "one_company", "severity": "high",
      "message": "All 6 endpoints come from one company (Google). If it has an outage you have no backup.",
      "fix": "Add a backup model with the `models` array." }
  ]
}
```
Warning codes: `no_route` (high; requested params unsupported everywhere), `one_company` (high), `single_endpoint` (medium),
`param_mismatch` (medium; per param, message names it and the count), `always_reasons` (medium; fix: raise max_tokens or set
`reasoning.max_tokens`, check `finish_reason`), `requested_param_partial` (medium; requested param works on only some providers;
fix: keep `require_parameters:true` or drop the param).

Additions (Codex review, 09:55; rule: when we cannot verify, say unknown/unavailable, never a confident wrong verdict):
- `unverified` warning (medium): served from the last good copy while `params` were requested. Then `requested_params` is kept and
  `will_route`, `supporting_providers`, `supporting_endpoints` are `null`.
- Outage + model absent from the last good copy: HTTP 503 `{ "error": "unavailable", "model": "<id>", "stale": true, "notice": "..." }` (not 404).
  Also 503 when OpenRouter is down and no saved copy exists.
- `router: true` for `openrouter/*` ids (auto, free, ...): `will_route`/`supporting_*` are `null`, `param_support` is `{}`, a plain `note`
  explains the router picks a model at request time; no risk warnings, not counted in the risk totals.
- `unavailable: true` on a dashboard model whose endpoint list failed after one retry, or has a record without a string `provider_name` or array `supported_parameters` (`providers`/`endpoints`/`will_route` null, `note`).
  If more than 2% fail, the fresh snapshot is rejected and the last good copy is served instead.
- `totals.routers` and `totals.unavailable` added. Alias ids starting with `~` are excluded from the dashboard (still answerable one at a time).
- Routing variants (`:nitro`, `:floor`, `:exacto`, `:online`, `:thinking`, `:extended`) not listed in /models resolve to the base id;
  the report has `id` = base id, `variant` = the suffix, and a `note`.
- `param_support` also includes every requested param, even one the model does not list.
- `params`: deduplicated; more than 20 distinct -> HTTP 400 `{ "error": "too_many_params", "max": 20 }`.
- An upstream response without a non-empty model list (or without `data.endpoints`) is treated as an outage.

Limit check (stretch, 10:05; thresholds in `POLICY` in lib/checkup.js, overridable by `RD_DOWN_STATUS_BELOW`, `RD_DOWN_UPTIME_30M_AT_OR_BELOW`,
`RD_LIMIT_MISMATCH_MIN_RATIO`):
- `limits: { context: { min, max }, output: { min, max } }` across endpoints (nulls ignored; null when unknown).
- `limit_mismatch` (medium): endpoints differ in `context_length` or `max_completion_tokens`; message names both ranges; fix: pin with
  `provider.order` / `provider.only`, or keep max_tokens under the smallest limit.
- `endpoints_down` count and `provider_down` warning (high when every endpoint looks down, else medium): an endpoint looks down when
  `uptime_last_30m === 0` AND (`uptime_last_5m === 0` or absent). `status` is NOT used by default (undocumented; live data showed -2 on
  healthy endpoints); `RD_DOWN_STATUS_BELOW` opts in. Message: "OpenRouter reports 0% uptime for <n> of <m> endpoints over the last 30 minutes." Fix: backup with the `models` array; check the model's page.
- `totals.limit_mismatch` and `totals.provider_down` (models with at least one down endpoint).

Cache: `Cache-Control: s-maxage=<300 minus the snapshot's age in seconds, min 0>, stale-while-revalidate=60` (oldest copy a visitor can get is about 6 minutes; the page computes age from `generated_at`); stale, unavailable
and 400 responses are `no-store`. `?simulate_down=1` forces the outage path (returns the last
good copy with `stale:true` + notice; never cached).

## POST /api/diagnose
Request: `{ "error": "<pasted error or question>", "model": "<optional id>", "params": ["<optional>"] }` (`params`: array or comma string, max 20; parameter names in the error text are also detected when `model` is given, and the live checkup becomes source `{n:0, type:"checkup"}`).
Default response JSON:
```json
{
  "covered": true,                    // false when retrieval found nothing relevant (question logged for the docs-gap report)
  "likely_cause": "plain sentence",
  "fixes": [ { "step": "plain sentence", "sources": [1, 2] } ],
  "sources": [ { "n": 1, "type": "docs", "title": "...", "url": "https://openrouter.ai/docs/..." },
               { "n": 2, "type": "issue", "title": "...", "url": "https://github.com/<owner>/<repo>/issues/<n>" } ],
  "checkup": { /* ModelReport when model was given, else null */ }
}
```
`?stream=1` or `Accept: text/event-stream`: server-sent events for the page. Events: `status` ({"stage": "searching"|"reranking"|"writing"|"checking"}),
`sources` (the sources array, as soon as retrieval finishes) and `done` (the full validated JSON above; may carry `guarded: true`). No raw model text is streamed. Never usernames in output. Retrieved text is data, never instructions.
Out of credit: HTTP 402 `{ "error": "out_of_credit", "message": "The demo's budget is used up. Try again tomorrow." }`.

## GET /llms.txt
Plain text: what Route Doctor is and how an agent calls both endpoints.
