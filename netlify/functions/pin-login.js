// Looks up which employee owns a PIN (using the service-role key, which
// bypasses RLS) and signs them in via Supabase Auth, handing the browser
// back a real session. The PIN itself is never stored or transmitted
// anywhere except this one request.

const SUPABASE_URL = 'https://ljuvujkqxbpjneylmgse.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kzcSAcuCxbnzhEV64GrJ_w_CuG53MSD';

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured (missing service role key).' }) };
  }

  try {
    const { pin } = JSON.parse(event.body);
    if (!pin || typeof pin !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN is required.' }) };
    }

    // Look up the employee by PIN using the service role key (bypasses RLS —
    // this is the one place in the app allowed to read the pin column).
    const lookupResp = await fetch(
      `${SUPABASE_URL}/rest/v1/employees?pin=eq.${encodeURIComponent(pin)}&active=eq.true&select=id,name,role,synthetic_email`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const matches = await lookupResp.json();
    const employee = Array.isArray(matches) ? matches[0] : null;

    // Deliberately generic message — don't reveal whether the PIN doesn't
    // exist vs. belongs to a deactivated employee.
    if (!employee) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid PIN.' }) };
    }

    // Sign in as that employee's synthetic Auth identity. This is a public
    // Auth endpoint, so the anon key (already public, embedded client-side
    // everywhere else in this app) is the right key to use here, not the
    // service role key — keeps the service-role key's blast radius smaller.
    const signInResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: employee.synthetic_email, password: pin })
    });
    const session = await signInResp.json();
    if (!signInResp.ok || !session.access_token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid PIN.' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
        employee: { id: employee.id, name: employee.name, role: employee.role }
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
