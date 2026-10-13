# Route Doctor

Unofficial helper for OpenRouter developers, not affiliated with OpenRouter. "Checkup before you build. Diagnosis when it breaks."

Built in a timed 1-hour session. Pre-clock setup (this commit): empty folder skeleton, `.gitignore`, `.env.example`. The build starts at the "Start: 1-hour build" commit.

| Folder | Role |
|---|---|
| `api/` | Vercel functions: `/api/checkup`, `/api/diagnose` |
| `public/` | The page and `llms.txt` (how agents use the API) |
| `scripts/` | Capture docs + GitHub issues, embed, store |
| `tests/` | Golden checkup cases and diagnosis questions (written before the code) |
| `docs/` | Notes and decisions |
