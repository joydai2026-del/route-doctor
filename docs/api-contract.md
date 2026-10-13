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

Cache: `Cache-Control: s-maxage=300, stale-while-revalidate=600`. `?simulate_down=1` forces the outage path (returns the last
good copy with `stale:true` + notice; never cached).

## POST /api/diagnose
Request: `{ "error": "<pasted error or question>", "model": "<optional id>" }`.
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
