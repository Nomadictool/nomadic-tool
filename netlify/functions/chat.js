// Claude chat proxy — requires a valid logged-in employee session. The model,
// token limit, and system prompt are pinned here so a caller can't use this
// endpoint to run arbitrary (expensive) requests against the API key.

const SUPABASE_URL = 'https://ljuvujkqxbpjneylmgse.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kzcSAcuCxbnzhEV64GrJ_w_CuG53MSD';

const CHAT_MODEL = 'claude-haiku-4-5-20251001';
const CHAT_MAX_TOKENS = 1024;
const CHAT_SYSTEM = 'You are a helpful assistant for Nomadic Clerical Support, a fire camp copy unit company. Help staff with questions about copy unit operations, invoicing procedures, equipment, and how to use the Nomadic Invoice Tool. Be concise, friendly, and practical. Do not offer to modify any software or settings — direct technical changes to admin.';
const MAX_MESSAGES = 40;

// Returns true only if the token belongs to an active employee.
async function verifyEmployee(accessToken, serviceKey) {
  if (!accessToken) return false;
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` }
  });
  if (!userResp.ok) return false;
  const user = await userResp.json();
  if (!user.id) return false;
  const empResp = await fetch(`${SUPABASE_URL}/rest/v1/employees?id=eq.${user.id}&select=id,active`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  const rows = await empResp.json();
  const emp = Array.isArray(rows) ? rows[0] : null;
  return !!(emp && emp.active);
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Chat not configured on the server. Contact your admin.' } }) };
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Server not configured. Contact your admin.' } }) };

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    const isEmployee = await verifyEmployee(accessToken, serviceKey);
    if (!isEmployee) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: { message: 'Please log in to use the chat.' } }) };
    }

    const { messages } = JSON.parse(event.body);
    if (!Array.isArray(messages) || !messages.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: { message: 'No messages provided.' } }) };
    }
    // Only pass through role/content, capped in count and size — nothing else from the client.
    const safeMessages = messages.slice(-MAX_MESSAGES).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 8000)
    }));

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: CHAT_MAX_TOKENS,
        system: CHAT_SYSTEM,
        messages: safeMessages
      })
    });

    const data = await resp.json();
    return { statusCode: resp.status, headers, body: JSON.stringify(data) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: err.message } }) };
  }
};
