# V4 grounding check: do the cited sources contain the fixes? (2026-10-13 ~10:16 ET)

**Grader:** GPT-6.1 Sol (a different model family from the answer model), run by JJ on the 12 golden answers from the live site. **Model-graded, not a human hand-check.**

| Level | Result | 95% Wilson range |
|---|---|---|
| Questions where every fix is supported | 5/12 (Q3, Q6, Q10, Q11, Q12) | 19-68% |
| Individual fixes supported by their cited source | 29/45 | 50-77% |
| Fabricated or dead source links | 0 | |

**Main failure:** unsupported certainty and lost conditions, not fabricated references.

| Pattern | Example |
|---|---|
| Lost condition | Q2: "disable reasoning" omitted the source's warning that mandatory-reasoning models reject that flag with HTTP 400 |
| Overstated guarantee | Q4: response healing presented as a sure fix; the docs say it attempts repair and cannot fix output cut off by `max_tokens` |
| Citation mismatch | Q5: docs guidance attributed to a GitHub issue; an issue with no root cause cited as support for a fix |
| Overgeneralized one report | Q8: one `openrouter/free` router report treated as the explanation for all 503 routing errors |
| Cause stated as fact | Q1, Q11: the question alone does not establish the likely cause |

**Changes made in response (same session):** every fix is labeled `documented` (OpenRouter docs or the live checkup) or `reported_workaround` (a GitHub issue), computed in code from the cited sources; the answer prompt now requires conditional phrasing, carries source caveats, forbids citing a source for guidance it does not state, and hedges the likely cause unless the live checkup or a doc establishes it.

**Not re-graded after the change** (time): the improvement is not measured. Re-running this grading on the new answers is the first Phase 2 eval.
