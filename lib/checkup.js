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

// Policy thresholds: safe defaults, overridable by RD_* env vars, validated (bad values fall back to the default).
function policyNumber(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[checkup] ignoring ${name}=${raw} (must be a number from ${min} to ${max}); using ${def}`);
    return def;
  }
  return n;
}
export const POLICY = Object.freeze({
  // OPT-IN, OFF by default (null): OpenRouter's endpoint `status` is undocumented, and live data on 2026-10-13
  // showed status -2 on 53 healthy endpoints (93-100% uptime). Set RD_DOWN_STATUS_BELOW to also treat status < N as down.
  downStatusBelow: process.env.RD_DOWN_STATUS_BELOW ? policyNumber('RD_DOWN_STATUS_BELOW', null, -100, 100) : null,
  // An endpoint looks down when its uptime over the last 30 minutes is at or below this percent AND the last 5 minutes
  // is too (or the 5-minute figure is missing).
  downUptime30mAtOrBelow: policyNumber('RD_DOWN_UPTIME_30M_AT_OR_BELOW', 0, 0, 100),
  // limit_mismatch fires when the largest limit divided by the smallest is above this ratio (1 = any difference).
  limitMismatchMinRatio: policyNumber('RD_LIMIT_MISMATCH_MIN_RATIO', 1, 1, 1000),
});

function looksDown(e) {
  if (POLICY.downStatusBelow !== null && typeof e.status === 'number' && e.status < POLICY.downStatusBelow) return true;
  const t = POLICY.downUptime30mAtOrBelow;
  if (typeof e.uptime_last_30m !== 'number' || e.uptime_last_30m > t) return false;
  return typeof e.uptime_last_5m !== 'number' || e.uptime_last_5m <= t;
}

function range(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : { min: null, max: null };
}

function tokens(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n % 1e3 ? 1 : 0)}K`;
  return String(n);
}

let memSnapshot = null; // { at: ms, data: snapshot }

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenRouter ${res.status} for ${url}`);
  return res.json();
}

async function fetchTextModels() {
  const body = await getJson(`${BASE}/models`);
  // A malformed or empty list is treated as an outage, never as "zero models".
  if (!Array.isArray(body?.data) || body.data.length === 0) throw new Error('OpenRouter /models returned no model list');
  return body.data.filter(
    (m) => (m.architecture?.output_modalities || []).includes('text') && !m.id.endsWith(':batch'),
  );
}

async function fetchEndpoints(id) {
  const body = await getJson(`${BASE}/models/${id}/endpoints`);
  if (!Array.isArray(body?.data?.endpoints)) throw new Error(`OpenRouter endpoints response malformed for ${id}`);
  // A malformed record would look like "unsupported"; treat it as unreadable (unavailable) instead.
  const bad = body.data.endpoints.some((e) => typeof e?.provider_name !== 'string' || !Array.isArray(e?.supported_parameters));
  if (bad) throw new Error(`OpenRouter endpoint record malformed for ${id}`);
  return body.data.endpoints;
}

async function fetchEndpointsRetry(id) {
  try {
    return await fetchEndpoints(id);
  } catch {
    return fetchEndpoints(id); // one retry
  }
}

const MAX_FAILED_SHARE = Number(process.env.RD_MAX_FAILED_SHARE || 0.02);
// Routing variants that OpenRouter accepts on any model id but does not list in /models.
const VARIANT_SUFFIXES = (process.env.RD_VARIANT_SUFFIXES || 'nitro,floor,exacto,online,thinking,extended').split(',');
const isRouter = (id) => id.startsWith('openrouter/');

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
  if (isRouter(model.id)) {
    return {
      id: model.id, name: model.name, router: true,
      providers: new Set(endpoints.map((e) => e.provider_name).filter(Boolean)).size, endpoints: endpoints.length,
      openrouter_url: `https://openrouter.ai/${model.id}`, requested_params: params,
      will_route: null, supporting_providers: null, supporting_endpoints: null, param_support: {},
      note: 'This is an OpenRouter router: it picks a real model at request time, so its backups and settings support depend on the model it picks. Check the model it chose (the `model` field in the response).',
      warnings: [],
    };
  }
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
      message: `${total === 1 ? 'The only endpoint comes' : `All ${total} endpoints come`} from one company (${providerNames[0]}). If it has an outage you have no backup.`,
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

  const limits = {
    context: range(endpoints.map((e) => e.context_length)),
    output: range(endpoints.map((e) => e.max_completion_tokens)),
  };
  const differs = (r) => r.min !== null && r.max / r.min > POLICY.limitMismatchMinRatio;
  if (differs(limits.context) || differs(limits.output)) {
    const parts = [];
    if (differs(limits.context)) parts.push(`Context ranges from ${tokens(limits.context.min)} to ${tokens(limits.context.max)} tokens across providers`);
    if (differs(limits.output)) parts.push(`${parts.length ? 'output' : 'Output'} from ${tokens(limits.output.min)} to ${tokens(limits.output.max)}`);
    warnings.push({
      code: 'limit_mismatch', severity: 'medium',
      message: `${parts.join('; ')}.`,
      fix: 'Long prompts or long answers may fail on the smaller providers. Use `provider.order` / `provider.only` to pin a provider with the limits you need, or keep max_tokens under the smallest limit.',
    });
  }

  const endpointsDown = endpoints.filter(looksDown).length;
  if (endpointsDown > 0) {
    warnings.push({
      code: 'provider_down', severity: endpointsDown === total ? 'high' : 'medium',
      message: `OpenRouter reports 0% uptime for ${endpointsDown} of ${total} endpoint${total === 1 ? '' : 's'} over the last 30 minutes.`,
      fix: `Add a backup model with the \`models\` fallback array, and check the model's page (https://openrouter.ai/${model.id}) for current uptime.`,
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
    limits,
    endpoints_down: endpointsDown,
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
  const has = (r, code) => !r.router && !r.unavailable && r.warnings.some((w) => w.code === code);
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
      limit_mismatch: reports.filter((r) => has(r, 'limit_mismatch')).length,
      provider_down: reports.filter((r) => has(r, 'provider_down')).length,
      routers: reports.filter((r) => r.router).length,          // not counted in the risk totals above
      unavailable: reports.filter((r) => r.unavailable).length, // endpoint list could not be read this time
    },
    models,
  };
}

export async function buildFreshSnapshot() {
  // Alias ids ("~vendor/x-latest") point at a real model already in the list; skip them so nothing is double counted.
  const models = (await fetchTextModels()).filter((m) => !m.id.startsWith('~'));
  const reports = await pool(models, CONCURRENCY, async (m) => {
    try {
      return buildReport(m, await fetchEndpointsRetry(m.id));
    } catch {
      // Unknown, not zero: keep the model visible and say we could not check it.
      return {
        id: m.id, name: m.name, unavailable: true, providers: null, endpoints: null,
        openrouter_url: `https://openrouter.ai/${m.id}`, requested_params: [], will_route: null,
        supporting_providers: null, supporting_endpoints: null, param_support: {}, warnings: [],
        note: "OpenRouter's provider list for this model could not be read just now, so it was not checked.",
      };
    }
  });
  const failed = reports.filter((r) => r.unavailable).length;
  if (failed > models.length * MAX_FAILED_SHARE) throw new Error(`${failed}/${models.length} endpoint lists failed`);
  return summarize(reports, new Date().toISOString());
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
 * Returns { report, stale? } | { notFound, suggestions } | { unavailable, notice }.
 * Principle: when we cannot verify, answer "unknown/unavailable", never a confident wrong verdict.
 */
export async function checkModel(id, params = [], { simulateDown = false } = {}) {
  const fromSnapshot = async () => {
    const snap = await getStaleSnapshot();
    if (!snap) return { unavailable: true, notice: "OpenRouter's model list could not be reached and no saved copy exists yet." };
    const lookup = resolveId(id, snap.models.map((m) => m.id));
    const base = lookup && snap.models.find((m) => m.id === lookup.id);
    // Absent from an old copy is not proof the model does not exist (it may be new): say unavailable, not 404.
    if (!base) return { unavailable: true, stale: true, notice: snap.notice };
    const report = { ...base, stale: true, generated_at: snap.generated_at, notice: snap.notice };
    if (lookup.variant) report.variant = lookup.variant;
    if (params.length && !base.router) {
      Object.assign(report, {
        requested_params: params, will_route: null, supporting_providers: null, supporting_endpoints: null,
        warnings: [...base.warnings, {
          code: 'unverified', severity: 'medium',
          message: `Your settings (${params.join(', ')}) could not be re-checked because OpenRouter could not be reached. This answer does not say whether they will work.`,
          fix: 'Try again in a few minutes. Until then, keep `provider.require_parameters: true` so a request never goes to a provider that ignores your settings.',
        }],
      });
    }
    return { report, stale: true };
  };
  if (simulateDown) return fromSnapshot();
  let models;
  try {
    models = await fetchTextModels();
  } catch {
    return fromSnapshot();
  }
  const ids = models.map((m) => m.id);
  const lookup = resolveId(id, ids);
  if (!lookup) return { notFound: true, suggestions: suggest(id, ids) };
  const model = models.find((m) => m.id === lookup.id);
  try {
    const report = buildReport(model, await fetchEndpointsRetry(model.id), params);
    if (lookup.variant) {
      report.variant = lookup.variant;
      report.note = `":${lookup.variant}" is an OpenRouter routing variant of ${model.id}. It uses the same providers but changes how one is picked, so the numbers here are for ${model.id}.`;
    }
    return { report };
  } catch {
    return fromSnapshot();
  }
}

function resolveId(id, ids) {
  if (ids.includes(id)) return { id };
  const m = id.match(/^(.+):([a-z]+)$/);
  if (m && VARIANT_SUFFIXES.includes(m[2]) && ids.includes(m[1])) return { id: m[1], variant: m[2] };
  return null;
}

/** ModelReport for one model (fast path), or null when the id is unknown or nothing is available. */
export async function getModelReport(id, params = []) {
  const r = await checkModel(id, params);
  return r.report || null;
}
