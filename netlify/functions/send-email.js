const SUPABASE_URL = 'https://ljuvujkqxbpjneylmgse.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kzcSAcuCxbnzhEV64GrJ_w_CuG53MSD';

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
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!resendKey || !fromEmail || !serviceKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email not configured on server' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');
  const isEmployee = await verifyEmployee(accessToken, serviceKey);
  if (!isEmployee) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { type, employeeName, incidentName, payPeriodStart, payPeriodEnd, lineItems } = body;

  try {
    const cfgRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?key=eq.hr_email&select=value`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
    });
    const cfgData = await cfgRes.json();
    const toEmail = cfgData?.[0]?.value?.address;
    if (!toEmail) {
      return { statusCode: 412, headers, body: JSON.stringify({ error: 'Admin email not set in app settings (Rates Admin → Admin Notification Email)' }) };
    }

    let subject, html;

    if (type === 'report_submitted') {
      const total = (lineItems || []).reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
      const itemRows = (lineItems || []).map(it => {
        const desc = it.description || (it.start_address ? `${it.start_address} → ${it.finish_address}` : '');
        const cat = (it.category || '').replace(/_/g, ' ');
        return `<tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${it.date || ''}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-transform:capitalize">${cat}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${desc || '&mdash;'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">$${(parseFloat(it.amount) || 0).toFixed(2)}</td>
        </tr>`;
      }).join('');

      subject = `Expense Report Submitted: ${employeeName} (${payPeriodStart} – ${payPeriodEnd})`;
      html = `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#222">
          <h2 style="color:#1a3a6b;border-bottom:2px solid #1a3a6b;padding-bottom:8px;margin-bottom:16px">Expense Report Submitted</h2>
          <p style="margin:4px 0"><strong>Employee:</strong> ${employeeName}</p>
          ${incidentName ? `<p style="margin:4px 0"><strong>Incident:</strong> ${incidentName}</p>` : ''}
          <p style="margin:4px 0"><strong>Pay Period:</strong> ${payPeriodStart} &ndash; ${payPeriodEnd}</p>
          <h3 style="color:#1a3a6b;margin-top:24px;margin-bottom:8px">Line Items</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
              <tr style="background:#1a3a6b;color:#fff">
                <th style="padding:8px 10px;text-align:left">Date</th>
                <th style="padding:8px 10px;text-align:left">Category</th>
                <th style="padding:8px 10px;text-align:left">Description</th>
                <th style="padding:8px 10px;text-align:right">Amount</th>
              </tr>
            </thead>
            <tbody>${itemRows || '<tr><td colspan="4" style="padding:10px;text-align:center;color:#999">No line items</td></tr>'}</tbody>
            <tfoot>
              <tr style="background:#f0f0f0;font-weight:bold">
                <td colspan="3" style="padding:8px 10px;text-align:right">Total</td>
                <td style="padding:8px 10px;text-align:right">$${total.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
          <p style="margin-top:24px;font-size:13px;color:#666">Log in to Nomadic Invoice Tool &rarr; Expense Review to approve this report.</p>
        </div>`;
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown email type' }) };
    }

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromEmail, to: [toEmail], subject, html }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('[send-email] Resend error:', errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Email delivery failed' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    console.error('[send-email] Exception:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
