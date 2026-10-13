// Golden check script. Written before the API code existed (minute 6-10 of the build).
// Usage: BASE=https://<host> node tests/run-golden.mjs [checkup|diagnose|all]
// Covers V1 (golden part), V2, V3, V5, V7 automatically and writes a hand-check sheet for V1 (random 10) and V4.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const which = process.argv[2] || "all";
const here = new URL(".", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("golden-checkup.json", here)));
const gdiag = JSON.parse(readFileSync(new URL("golden-diagnose.json", here)));
const results = [];
const log = (id, pass, detail, info = false) => { results.push({ id, pass, detail, info }); console.log(`${pass ? "PASS" : info ? "INFO" : "FAIL"} ${id} ${detail}`); };
const T = () => ({ signal: AbortSignal.timeout(60000) });

// Wilson score interval, 95%.
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d].map(x => Math.round(x * 100));
}

async function getJson(path, init) {
  const r = await fetch(BASE + path, { ...init, ...T() });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, headers: r.headers, body };
}

// Independent oracle: recompute from OpenRouter's raw endpoints API, separate from our code.
async function oracle(model, params) {
  const r = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`, T());
  if (!r.ok) return null;
  const e = (await r.json()).data.endpoints;
  const sup = e.filter(x => params.every(p => x.supported_parameters.includes(p)));
  return { providers: new Set(e.map(x => x.provider_name)).size, endpoints: e.length,
    supporting_endpoints: sup.length, supporting_providers: new Set(sup.map(x => x.provider_name)).size,
    will_route: sup.length > 0 };
}

async function checkup() {
  // V1 golden: frozen expectations, plus a live oracle so drift is told apart from a bug.
  for (const c of golden.cases) {
    const q = `/api/checkup?model=${encodeURIComponent(c.model)}` + (c.params.length ? `&params=${c.params.join(",")}` : "");
    const { status, body } = await getJson(q);
    if (status !== 200 || !body) { log(`V1-${c.id}`, false, `HTTP ${status}`); continue; }
    const errs = [], drift = [];
    const live = await oracle(c.model, c.params);
    for (const k of ["providers", "endpoints", "will_route", "supporting_endpoints", "supporting_providers"]) {
      if (!(k in c.expect)) continue;
      if (!live) errs.push(`${k}: live oracle unavailable, cannot verify`);
      else if (body[k] !== live[k]) errs.push(`${k}: api ${body[k]} != live oracle ${live[k]} (frozen ${c.expect[k]})`);
      if (live && live[k] !== c.expect[k]) drift.push(`${k}: frozen ${c.expect[k]}, live ${live[k]}, api ${body[k]}`);
    }
    for (const [p, n] of Object.entries(c.expect.param_support || {})) {
      const got = body.param_support?.[p]?.endpoints;
      if (got !== n) errs.push(`param_support.${p}: expected ${n}, got ${got}`);
    }
    if ((c.expect.warnings_exclude || []).length && !Array.isArray(body.warnings)) errs.push("warnings is not an array");
    const codes = (body.warnings || []).map(w => w.code);
    for (const w of c.expect.warnings_include || []) if (!codes.includes(w)) errs.push(`missing warning ${w}`);
    for (const w of c.expect.warnings_exclude || []) if (codes.includes(w)) errs.push(`unexpected warning ${w}`);
    for (const w of body.warnings || []) if (!w.message || !w.fix) errs.push(`warning ${w.code} lacks message/fix`);
    log(`V1-${c.id}`, errs.length === 0, `${c.model} ${c.params.join(",")} ${errs.join("; ")}${drift.length ? " DRIFT(info, frozen vs live): " + drift.join("; ") : ""}`);
  }
  const nf = await getJson(`/api/checkup?model=${encodeURIComponent(golden.not_found.model)}`);
  log("V1-notfound", nf.status === 404 && nf.body?.error === "model_not_found", `HTTP ${nf.status} ${nf.body?.error}`);

  // V2 freshness + outage path.
  const s = await getJson("/api/checkup");
  const age = s.body?.generated_at ? (Date.now() - Date.parse(s.body.generated_at)) / 1000 : Infinity;
  const tot = s.body?.totals;
  const totOk = !!tot && ["models", "one_company", "single_endpoint", "param_mismatch", "always_reasons"].every(k => typeof tot[k] === "number") && tot.models > 0;
  const modelsOk = Array.isArray(s.body?.models) && s.body.models.length > 0;
  // Reconcile totals against models[] (same rule as lib/checkup.js: risk counts skip router/unavailable entries).
  const rec = [];
  if (totOk && modelsOk) {
    const ms = s.body.models;
    if (tot.models !== ms.length) rec.push(`totals.models ${tot.models} != models.length ${ms.length}`);
    for (const code of ["one_company", "single_endpoint", "param_mismatch", "always_reasons"]) {
      const n = ms.filter(m => !m.router && !m.unavailable && (m.warnings || []).some(w => w.code === code)).length;
      if (tot[code] !== n) rec.push(`totals.${code} ${tot[code]} != counted ${n}`);
    }
  }
  log("V2-fresh", s.status === 200 && age < 300 && s.body?.stale === false && totOk && modelsOk && rec.length === 0, `totals_ok=${totOk} models_ok=${modelsOk} reconcile=${rec.join("; ") || "ok"} age ${Math.round(age)}s, cache-control "${s.headers.get("cache-control")}"`);
  const d = await getJson("/api/checkup?simulate_down=1");
  const ccd = d.headers.get("cache-control") || "";
  log("V2-outage", d.status === 200 && /no-store/i.test(ccd) && d.body?.stale === true && !!d.body?.notice && !!d.body?.generated_at, `stale=${d.body?.stale} notice="${d.body?.notice}" as_of=${d.body?.generated_at} cache-control="${ccd}"`);

  // V1 hand-check sheet: 10 random models for JJ to compare against openrouter.ai.
  if (s.body?.models?.length) {
    const pick = [...s.body.models].sort(() => Math.random() - 0.5).slice(0, 10);
    mkdirSync(new URL("../scratch/", here), { recursive: true });
    writeFileSync(new URL("../scratch/handcheck-v1.md", here), "# V1 hand-check (10 random models)\nOpen each link; tick if providers/endpoints/warnings match the Providers tab.\n\n" +
      pick.map((m, i) => `${i + 1}. [ ] ${m.id}: ${m.providers} providers, ${m.endpoints} endpoints, warnings: ${(m.warnings || []).map(w => w.code).join(", ") || "none"}. ${m.openrouter_url}`).join("\n") + "\n");
    console.log("wrote scratch/handcheck-v1.md");
  }
}

async function diagnose() {
  const post = (q, model) => getJson("/api/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: q, model }) });
  let hits = 0; const sheet = [];
  for (const g of gdiag.questions) {
    const { status, body } = await post(g.q, g.model);
    const top5 = (body?.sources || []).slice(0, 5).map(s => s.url);
    const hit = status === 200 && body?.covered === true && typeof body?.likely_cause === "string" && body.likely_cause.trim() !== "" && Array.isArray(body?.fixes) && body.fixes.length >= 1 && body.fixes.every(f => f && typeof f.step === "string" && f.step.trim() !== "" && Array.isArray(f.sources) && f.sources.length > 0 && f.sources.every(Number.isInteger)) && top5.some(u => g.expect_any.some(e => u.includes(e)));
    if (hit) hits++;
    log(`V3-${g.id}`, hit, `HTTP ${status} covered=${body?.covered} top5=${top5.map(u => u.replace(/^https:\/\/(openrouter\.ai\/docs\/|github\.com\/)/, "")).join(" | ")}`, true);
    sheet.push(`## ${g.id}: ${g.q}\nLikely cause: ${body?.likely_cause}\n` + (body?.fixes || []).map(f => `- [ ] ${f.step} [${(f.sources || []).join(",")}]`).join("\n") + "\n" + (body?.sources || []).map(s => `  ${s.n}. ${s.title} ${s.url}`).join("\n"));
  }
  const [lo, hi] = wilson(hits, gdiag.questions.length);
  log("V3-total", hits >= 10, `${hits}/${gdiag.questions.length} (95% Wilson ${lo}-${hi}%)`);
  mkdirSync(new URL("../scratch/", here), { recursive: true });
  writeFileSync(new URL("../scratch/handcheck-v4.md", here), "# V4 hand-check: open the cited source; tick a fix only if that source contains it\n\n" + sheet.join("\n\n") + "\n");
  console.log("wrote scratch/handcheck-v4.md");

  for (const o of gdiag.off_topic) {
    const { body } = await post(o.q);
    log(`V5-${o.id}`, body?.covered === false, `covered=${body?.covered}`);
  }
  const inj = await post(gdiag.injection.q);
  const text = JSON.stringify(inj.body || {}).toLowerCase();
  const bad = gdiag.injection.must_not_contain.filter(s => text.includes(s.toLowerCase()));
  const shapeOk = inj.status === 200 && inj.body && typeof inj.body === "object" && inj.body.covered === true && typeof inj.body.likely_cause === "string" && inj.body.likely_cause.trim() !== "" && Array.isArray(inj.body.fixes);
  const planted = (inj.body?.sources || []).some(s => String(s.url || "").includes("tests/fixtures/planted-issue.md"));
  const v7pass = shapeOk && planted && bad.length === 0;
  log("V7-injection", v7pass, !shapeOk ? `bad response shape, HTTP ${inj.status}` : !planted ? "planted source not retrieved, test inconclusive" : bad.length ? `obeyed planted text: ${bad.join(", ")}` : "planted source retrieved; instruction not obeyed");
}

if (which === "checkup" || which === "all") await checkup();
if (which === "diagnose" || which === "all") await diagnose();
const isGate = r => !r.info && !/^V3-Q\d/.test(r.id); // per-question V3 rows are informational; V3-total gates
const failed = results.filter(r => isGate(r) && !r.pass);
const gates = results.filter(isGate);
console.log(`\n${gates.length - failed.length}/${gates.length} gate checks passed (INFO lines excluded from failures) against ${BASE}`);
writeFileSync(new URL("../scratch/golden-results.json", here), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);
