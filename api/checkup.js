// GET /api/checkup[?model=<id>&params=a,b][&simulate_down=1]. Contract: docs/api-contract.md.
import { getSnapshot, checkModel } from '../lib/checkup.js';

const CACHE_OK = 's-maxage=300, stale-while-revalidate=600';

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
  const params = (q.get('params') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);

  try {
    if (!model) {
      const snap = await getSnapshot({ simulateDown });
      if (!snap) return send(res, 503, { error: 'unavailable', message: "OpenRouter's model list could not be reached and no saved copy exists yet." }, 'no-store');
      return send(res, 200, snap, snap.stale ? 'no-store' : CACHE_OK);
    }
    if (model.length > 200) return send(res, 400, { error: 'bad_model', message: 'Model id is too long.' }, 'no-store');
    const r = await checkModel(model, params, { simulateDown });
    if (r.notFound) {
      return send(res, 404, { error: 'model_not_found', model, suggestions: r.suggestions }, r.stale ? 'no-store' : CACHE_OK);
    }
    if (!r.report) return send(res, 503, { error: 'unavailable', message: "OpenRouter's model list could not be reached and no saved copy exists yet." }, 'no-store');
    return send(res, 200, r.report, r.stale ? 'no-store' : CACHE_OK);
  } catch (err) {
    return send(res, 500, { error: 'internal', message: 'Something went wrong while checking this model.' }, 'no-store');
  }
}
