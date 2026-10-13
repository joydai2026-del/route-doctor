# V1 hand-check: 10 random models vs openrouter.ai (JJ, 2026-10-13 ~10:04 ET)

Result: **10/10 match** (95% Wilson range 72-100%).

- Provider and endpoint counts matched the Providers tab for all 10; OpenRouter's endpoints API returned the same counts.
- One-provider pages (9 models) each showed exactly one provider row, supporting `one_company` + `single_endpoint`.
- minimax/minimax-m2: the two endpoints differ on exactly 10 supported parameters (seed, response_format, top_k, repetition_penalty, frequency_penalty, presence_penalty, stop, structured_outputs, logprobs, top_logprobs), matching the 10 `param_mismatch` flags.
- `always_reasons` uses OpenRouter's `reasoning.mandatory` field, not "lists reasoning": Fugu Ultra and MiniMax M2 are `mandatory: true` (flagged); o1, Sonar Reasoning Pro, Solar Pro 3, Inkling are `mandatory: false` (not flagged). Re-verified live at 10:05.
- Finding that changed the product: Amazon Nova Premier's only endpoint reports `status: -5` and 0% uptime, which the checkup ignored. Added a `provider_down` warning from published uptime data.
