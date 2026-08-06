// Geocoding + driving-distance matrix for the Locations map.
// Admin-only. ORS_API_KEY stays server-side; the browser never sees it.

const SUPABASE_URL = 'https://ljuvujkqxbpjneylmgse.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kzcSAcuCxbnzhEV64GrJ_w_CuG53MSD';
const ORS_BASE = 'https://api.openrouteservice.org';
const MAX_QUERIES = 40;   // sanity cap per request
const MAX_LOCATIONS = 25; // matrix grows N^2 — keep it small

async function verifyAdmin(accessToken, serviceKey) {
  if (!accessToken) return false;
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` }
  });
  if (!userResp.ok) return false;
  const user = await userResp.json();
  if (!user.id) return false;
  const empResp = await fetch(`${SUPABASE_URL}/rest/v1/employees?id=eq.${user.id}&select=role,active`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  const rows = await empResp.json();
  const emp = Array.isArray(rows) ? rows[0] : null;
  return !!(emp && emp.role === 'admin' && emp.active);
}

// "39.1,-121.6" typed straight into the location field — skip the geocoder.
function parseLatLng(text) {
  const m = String(text).trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, label: `${lat}, ${lng}` };
}

async function geocodeOne(query, orsKey) {
  const direct = parseLatLng(query);
  if (direct) return { query, ...direct };
  const url = `${ORS_BASE}/geocode/search?api_key=${encodeURIComponent(orsKey)}`
    + `&text=${encodeURIComponent(query)}&size=1&boundary.country=US`;
  const resp = await fetch(url);
  if (!resp.ok) return { query, error: 'Geocoder returned ' + resp.status };
  const data = await resp.json();
  const feat = data && data.features && data.features[0];
  if (!feat) return { query, error: 'No match found' };
  const [lng, lat] = feat.geometry.coordinates;
  return { query, lat, lng, label: (feat.properties && feat.properties.label) || query };
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured.' }) };

  const orsKey = process.env.ORS_API_KEY;
  if (!orsKey) {
    return { statusCode: 501, headers, body: JSON.stringify({
      error: 'Mapping is not set up yet. Add an ORS_API_KEY environment variable in Netlify (free key from openrouteservice.org), then redeploy.'
    }) };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!(await verifyAdmin(accessToken, serviceKey))) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin authorization required.' }) };
    }

    const body = JSON.parse(event.body || '{}');

    if (body.action === 'geocode') {
      const queries = Array.isArray(body.queries) ? body.queries.slice(0, MAX_QUERIES) : [];
      if (!queries.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No queries provided.' }) };
      const results = [];
      // Sequential — ORS free tier rate-limits bursts, and this only runs for
      // locations that aren't already cached client-side.
      for (const q of queries) {
        try { results.push(await geocodeOne(String(q), orsKey)); }
        catch (e) { results.push({ query: q, error: e.message }); }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ results }) };
    }

    if (body.action === 'matrix') {
      const locations = Array.isArray(body.locations) ? body.locations.slice(0, MAX_LOCATIONS) : [];
      if (locations.length < 2) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Need at least two locations.' }) };
      const resp = await fetch(`${ORS_BASE}/v2/matrix/driving-car`, {
        method: 'POST',
        headers: { Authorization: orsKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations, metrics: ['distance', 'duration'], units: 'mi' }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = (data && data.error && (data.error.message || data.error)) || ('Routing returned ' + resp.status);
        return { statusCode: 502, headers, body: JSON.stringify({ error: String(msg) }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ distances: data.distances, durations: data.durations }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
