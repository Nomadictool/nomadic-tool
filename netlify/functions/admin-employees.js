// Employee CRUD — every action except the one-time bootstrap requires a
// verified admin session. Creating/deactivating Auth users requires the
// service-role key, which is why this can't happen from the browser
// directly (the anon key has no permission to do this, by design).

const SUPABASE_URL = 'https://ljuvujkqxbpjneylmgse.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kzcSAcuCxbnzhEV64GrJ_w_CuG53MSD';

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'employee';
}
function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function restFetch(path, serviceKey, opts = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  return resp;
}

async function authAdminFetch(path, serviceKey, opts = {}) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    ...opts,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  return resp;
}

// Returns the calling employee's id if they're a verified, active admin; null otherwise.
async function verifyAdmin(accessToken, serviceKey) {
  if (!accessToken) return null;
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` }
  });
  if (!userResp.ok) return null;
  const user = await userResp.json();
  const empResp = await restFetch(`employees?id=eq.${user.id}&select=id,role,active`, serviceKey);
  const rows = await empResp.json();
  const emp = Array.isArray(rows) ? rows[0] : null;
  return (emp && emp.role === 'admin' && emp.active) ? emp.id : null;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured (missing service role key).' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { action, adminAccessToken } = body;

    // ── CREATE ──────────────────────────────────────────────────
    if (action === 'create') {
      let { name, pin, role } = body;
      if (!name || !pin) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and PIN are required.' }) };

      // Bootstrap: if no employees exist yet, allow creating the very first
      // one (forced to admin) without requiring an admin token already.
      const countResp = await restFetch('employees?select=id&limit=1', serviceKey);
      const existing = await countResp.json();
      const isBootstrap = Array.isArray(existing) && existing.length === 0;

      if (isBootstrap) {
        role = 'admin';
      } else {
        const adminId = await verifyAdmin(adminAccessToken, serviceKey);
        if (!adminId) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin authorization required.' }) };
        role = role === 'admin' ? 'admin' : 'staff';
      }

      const syntheticEmail = `${slugify(name)}-${randomSuffix()}@employees.nomadic.internal`;

      const createUserResp = await authAdminFetch('users', serviceKey, {
        method: 'POST',
        body: JSON.stringify({ email: syntheticEmail, password: pin, email_confirm: true })
      });
      const createdUser = await createUserResp.json();
      if (!createUserResp.ok) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: createdUser.msg || createdUser.message || 'Could not create employee login.' }) };
      }

      const insertResp = await restFetch('employees', serviceKey, {
        method: 'POST',
        body: JSON.stringify({ id: createdUser.id, name, pin, role, synthetic_email: syntheticEmail, active: true })
      });
      if (!insertResp.ok) {
        const errBody = await insertResp.json().catch(() => ({}));
        // Roll back the auth user so we don't leave an orphaned login with no employee row.
        await authAdminFetch(`users/${createdUser.id}`, serviceKey, { method: 'DELETE' });
        const msg = (errBody.message || '').includes('pin')
          ? 'That PIN is already in use by another active employee.'
          : (errBody.message || 'Could not save employee.');
        return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ employee: { id: createdUser.id, name, role, active: true } }) };
    }

    // ── All other actions require an already-verified admin ─────
    const adminId = await verifyAdmin(adminAccessToken, serviceKey);
    if (!adminId) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin authorization required.' }) };

    const { employeeId } = body;
    if (!employeeId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'employeeId is required.' }) };

    if (action === 'deactivate') {
      await restFetch(`employees?id=eq.${employeeId}`, serviceKey, { method: 'PATCH', body: JSON.stringify({ active: false }) });
      // Ban the Auth user too so an already-issued session can't refresh past its current expiry.
      await authAdminFetch(`users/${employeeId}`, serviceKey, { method: 'PUT', body: JSON.stringify({ ban_duration: '876000h' }) });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'reactivate') {
      await restFetch(`employees?id=eq.${employeeId}`, serviceKey, { method: 'PATCH', body: JSON.stringify({ active: true }) });
      await authAdminFetch(`users/${employeeId}`, serviceKey, { method: 'PUT', body: JSON.stringify({ ban_duration: 'none' }) });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'changePin') {
      const { pin } = body;
      if (!pin) return { statusCode: 400, headers, body: JSON.stringify({ error: 'New PIN is required.' }) };
      const patchResp = await restFetch(`employees?id=eq.${employeeId}`, serviceKey, { method: 'PATCH', body: JSON.stringify({ pin }) });
      if (!patchResp.ok) {
        const errBody = await patchResp.json().catch(() => ({}));
        const msg = (errBody.message || '').includes('pin') ? 'That PIN is already in use by another active employee.' : (errBody.message || 'Could not change PIN.');
        return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
      }
      await authAdminFetch(`users/${employeeId}`, serviceKey, { method: 'PUT', body: JSON.stringify({ password: pin }) });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'delete') {
      await restFetch(`employees?id=eq.${employeeId}`, serviceKey, { method: 'DELETE' });
      await authAdminFetch(`users/${employeeId}`, serviceKey, { method: 'DELETE' });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
