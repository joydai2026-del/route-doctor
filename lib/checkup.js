// Route Doctor checkup: reads OpenRouter's public model + endpoint lists (no AI, no key)
// and turns them into plain-English routing risk reports. Contract: docs/api-contract.md.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
const CONCURRENCY = Number(process.env.RD_CHECKUP_CONCURRENCY || 24);
const MEMORY_TTL_MS = Number(process.env.RD_CHECKUP_TTL_MS || 5 * 60 * 1000);
const FETCH_TIMEOUT_MS = Number(process.env.RD_FETCH_TIMEOUT_MS || 8000);
const LAST_GOOD_PATH = process.env.RD_LAST_GOOD_PATH || '/tmp/rd-last-good.json';
const BUILD_SNAPSHOT_PATH = fileURLToPath(new URL('./snapshot.json', import.meta.url));

let memSnapshot = null; // { at: ms, data: snapshot }

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenRouter ${res.status} for ${url}`);
  return res.json();
}

async function fetchTextModels() {
  const body = await getJson(`${BASE}/models`);
  return (body.data || []).filter(
    (m) => (m.architecture?.output_modalities || []).includes('text') && !m.id.endsWith(':batch'),
  );
}

async function fetchEndpoints(id) {
  const body = await getJson(`${BASE}/models/${id}/endpoints`);
  return body?.data?.endpoints || [];
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function list(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const SEVERITY_SCORE = { high: 10, medium: 3 };

export function buildReport(model, endpoints, requestedParams = []) {
  const params = [...new Set(requestedParams.map((p) => p.trim()).filter(Boolean))];
  const providerNames = [...new Set(endpoints.map((e) => e.provider_name).filter(Boolean))];
  const total = endpoints.length;
  const supports = (e, p) => (e.supported_parameters || []).includes(p);

  const param_support = {};
  const listed = model.supported_parameters || [];
  // Every param the model lists, plus any requested param (so "temperature: 0 of 10" is visible even when unlisted).
  for (const p of [...listed, ...params.filter((x) => !listed.includes(x))]) {
    param_support[p] = { endpoints: endpoints.filter((e) => supports(e, p)).length, of: total };
  }

  const supportingEps = endpoints.filter((e) => params.every((p) => supports(e, p)));
  const supportingProviders = new Set(supportingEps.map((e) => e.provider_name));
  const warnings = [];

  if (params.length && supportingEps.length === 0) {
    warnings.push({
      code: 'no_route', severity: 'high',
      message: `No provider for this model supports every setting you asked for (${params.join(', ')}). With provider.require_parameters on, the request fails; with it off, a provider may silently ignore the setting.`,
      fix: `Drop the unsupported setting, or pick a different model that supports it. You can list backups in the \`models\` fallback array.`,
    });
  }
  if (providerNames.length === 1) {
    warnings.push({
      code: 'one_company', severity: 'high',
      message: `All ${total} endpoint${total === 1 ? '' : 's'} come from one company (${providerNames[0]}). If it has an outage you have no backup.`,
      fix: 'Add a backup model from a different company with the `models` fallback array.',
    });
  }
  if (total === 1) {
    warnings.push({
      code: 'single_endpoint', severity: 'medium',
      message: 'Only one endpoint serves this model, so OpenRouter has nowhere else to send your request if it is slow or down.',
      fix: 'Add a backup model with the `models` fallback array.',
    });
  }
  for (const [p, s] of Object.entries(param_support)) {
    if (listed.includes(p) && s.endpoints < s.of) {
      warnings.push({
        code: 'param_mismatch', severity: 'medium', param: p,
        message: `The model lists "${p}" but only ${s.endpoints} of ${s.of} endpoints support it. On the others it may be ignored.`,
        fix: `If you rely on "${p}", set \`provider.require_parameters: true\` so OpenRouter only uses endpoints that honor it.`,
      });
    }
  }
  if (model.reasoning?.mandatory === true) {
    warnings.push({
      code: 'always_reasons', severity: 'medium',
      message: 'This model always thinks before answering and the thinking cannot be turned off. The thinking uses up your token budget, so a small max_tokens can end with an empty or cut-off answer.',
      fix: 'Raise max_tokens, or cap the thinking with `reasoning.max_tokens` or `reasoning.effort`. Check `finish_reason`: "length" means the budget ran out.',
    });
  }
  if (params.length && supportingEps.length > 0 && supportingProviders.size < providerNames.length) {
    const missing = providerNames.filter((n) => !supportingProviders.has(n));
    warnings.push({
      code: 'requested_param_partial', severity: 'medium',
      message: `Your settings (${params.join(', ')}) work on only ${supportingProviders.size} of ${providerNames.length} companies. ${list(missing.slice(0, 5))}${missing.length > 5 ? ' and others' : ''} would ignore or reject them.`,
      fix: 'Keep `provider.require_parameters: true` so requests only go where the settings work, or drop the setting to keep more backups.',
    });
  }

  return {
    id: model.id,
    name: model.name,
    providers: providerNames.length,
    endpoints: total,
    openrouter_url: `https://openrouter.ai/${model.id}`,
    requested_params: params,
    will_route: params.length ? supportingEps.length > 0 : total > 0,
    supporting_providers: params.length ? supportingProviders.size : providerNames.length,
    supporting_endpoints: params.length ? supportingEps.length : total,
    param_support,
    warnings,
  };
}

function riskScore(r) {
  // Each warning code counts once, so many param mismatches never outrank having no backup company.
  const seen = new Map(r.warnings.map((w) => [w.code, w.severity]));
  let s = 0;
  for (const sev of seen.values()) s += SEVERITY_SCORE[sev] || 0;
  return s;
}

function summarize(reports, generatedAt) {
  const has = (r, code) => r.warnings.some((w) => w.code === code);
  const models = [...reports].sort((a, b) => riskScore(b) - riskScore(a) || a.providers - b.providers || a.id.localeCompare(b.id));
  return {
    generated_at: generatedAt,
    stale: false,
    notice: null,
    totals: {
      models: reports.length,
      one_company: reports.filter((r) => has(r, 'one_company')).length,
      single_endpoint: reports.filter((r) => has(r, 'single_endpoint')).length,
      param_mismatch: reports.filter((r) => has(r, 'param_mismatch')).length,
      always_reasons: reports.filter((r) => has(r, 'always_reasons')).length,
    },
    models,
  };
}

export async function buildFreshSnapshot() {
  // Alias ids ("~vendor/x-latest") point at a real model already in the list; skip them so nothing is double counted.
  const models = (await fetchTextModels()).filter((m) => !m.id.startsWith('~'));
  const reports = await pool(models, CONCURRENCY, async (m) => {
    try {
      return buildReport(m, await fetchEndpoints(m.id));
    } catch {
      return null; // one model's endpoint list failing should not sink the whole dashboard
    }
  });
  const ok = reports.filter(Boolean);
  if (ok.length < models.length * 0.9) throw new Error(`Only ${ok.length}/${models.length} endpoint lists loaded`);
  return summarize(ok, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

async function loadLastGood() {
  for (const p of [LAST_GOOD_PATH, BUILD_SNAPSHOT_PATH]) {
    try {
      return JSON.parse(await readFile(p, 'utf8'));
    } catch { /* try next */ }
  }
  return null;
}

export async function getStaleSnapshot() {
  const last = memSnapshot?.data || (await loadLastGood());
  if (!last) return null;
  return {
    ...last,
    stale: true,
    notice: `OpenRouter's model list could not be reached. Showing the last good copy from ${last.generated_at}.`,
  };
}

/** Full dashboard. Returns the live snapshot, or the last good copy with stale:true on failure. */
export async function getSnapshot({ simulateDown = false } = {}) {
  if (simulateDown) return getStaleSnapshot();
  if (memSnapshot && Date.now() - memSnapshot.at < MEMORY_TTL_MS) return memSnapshot.data;
  try {
    const data = await buildFreshSnapshot();
    memSnapshot = { at: Date.now(), data };
    writeFile(LAST_GOOD_PATH, JSON.stringify(data)).catch(() => {});
    return data;
  } catch {
    return getStaleSnapshot();
  }
}

function suggest(id, ids) {
  const q = id.toLowerCase();
  const tail = q.split('/').pop();
  const scored = ids.map((x) => {
    const l = x.toLowerCase();
    let s = 0;
    if (l.includes(q)) s += 100;
    if (tail && l.includes(tail)) s += 50;
    // shared leading characters of the part after the slash
    const lt = l.split('/').pop();
    let k = 0;
    while (k < lt.length && k < tail.length && lt[k] === tail[k]) k++;
    s += k * 2;
    for (const tok of tail.split(/[-.:_]/).filter((t) => t.length > 1)) if (l.includes(tok)) s += 3;
    return [x, s];
  });
  return scored.filter(([, s]) => s > 4).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([x]) => x);
}

/**
 * One model, fast path (model list + that model's endpoints only).
 * Returns { report } | { notFound: true, suggestions } | { report, stale, notice } from the last good copy.
 */
export async function checkModel(id, params = [], { simulateDown = false } = {}) {
  const fromSnapshot = async () => {
    const snap = await getStaleSnapshot();
    if (!snap) return { error: 'unavailable' };
    const base = snap.models.find((m) => m.id === id);
    if (!base) return { notFound: true, suggestions: suggest(id, snap.models.map((m) => m.id)), stale: true, notice: snap.notice };
    // Requested params cannot be re-checked without endpoint lists; the cached report has none, so report as-is.
    const notice = params.length
      ? `${snap.notice} Your requested settings (${params.join(', ')}) could not be re-checked while OpenRouter is unreachable.`
      : snap.notice;
    return { report: { ...base, requested_params: [], stale: true, generated_at: snap.generated_at, notice }, stale: true };
  };
  if (simulateDown) return fromSnapshot();
  let models;
  try {
    models = await fetchTextModels();
  } catch {
    return fromSnapshot();
  }
  const model = models.find((m) => m.id === id);
  if (!model) return { notFound: true, suggestions: suggest(id, models.map((m) => m.id)) };
  try {
    return { report: buildReport(model, await fetchEndpoints(id), params) };
  } catch {
    return fromSnapshot();
  }
}

/** ModelReport for one model (fast path), or null when the id is unknown or nothing is available. */
export async function getModelReport(id, params = []) {
  const r = await checkModel(id, params);
  return r.report || null;
}
