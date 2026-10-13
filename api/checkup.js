// GET /api/checkup[?model=<id>&params=a,b][&simulate_down=1]. Contract: docs/api-contract.md.
import { getSnapshot, checkModel } from '../lib/checkup.js';

const FRESH_SECONDS = Number(process.env.RD_CDN_FRESH_SECONDS || 300);
const MAX_PARAMS = Number(process.env.RD_MAX_PARAMS || 20);
// CDN lifetime counts from when the data was generated, so memory cache + CDN cache never stack past 5 minutes.
function cacheFor(generatedAt) {
  const age = generatedAt ? Math.floor((Date.now() - Date.parse(generatedAt)) / 1000) : 0;
  return `s-maxage=${Math.max(0, FRESH_SECONDS - Math.max(0, age))}, stale-while-revalidate=600`;
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method_not_allowed', message: 'Use GET.' }, 'no-store');
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const q = url.searchParams;
  const simulateDown = q.get('simulate_down') === '1';
  const model = (q.get('model') || '').trim();
  const params = (q.get('params') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const uniqueParams = [...new Set(params)];
  if (uniqueParams.length > MAX_PARAMS) {
    return send(res, 400, { error: 'too_many_params', message: `Ask about at most ${MAX_PARAMS} settings at once.`, max: MAX_PARAMS }, 'no-store');
  }

  try {
    if (!model) {
      const snap = await getSnapshot({ simulateDown });
      if (!snap) return send(res, 503, { error: 'unavailable', message: "OpenRouter's model list could not be reached and no saved copy exists yet." }, 'no-store');
      return send(res, 200, snap, snap.stale ? 'no-store' : cacheFor(snap.generated_at));
    }
    if (model.length > 200) return send(res, 400, { error: 'bad_model', message: 'Model id is too long.' }, 'no-store');
    const r = await checkModel(model, uniqueParams, { simulateDown });
    if (r.notFound) return send(res, 404, { error: 'model_not_found', model, suggestions: r.suggestions }, cacheFor(null));
    if (!r.report) return send(res, 503, { error: 'unavailable', model, stale: !!r.stale, notice: r.notice }, 'no-store');
    return send(res, 200, r.report, r.stale ? 'no-store' : cacheFor(null));
  } catch (err) {
    return send(res, 500, { error: 'internal', message: 'Something went wrong while checking this model.' }, 'no-store');
  }
}
