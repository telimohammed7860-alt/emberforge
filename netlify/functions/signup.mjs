// Emberforge signup: creates the account already confirmed, so no confirmation email is needed.
const env = (k) => (typeof Netlify !== 'undefined' ? Netlify.env.get(k) : process.env[k]);
const SB = (env('SUPABASE_URL') || '').replace(/\/$/, '');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const J = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });
const hits = new Map(); // simple per-visitor limit (resets when the function restarts)
const MAX_PER_HOUR = 5;
function tooMany(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= MAX_PER_HOUR) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return false;
}
const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'content-type': 'application/json' };
export default async (req) => {
  if (req.method !== 'POST') return J(405, { error: 'Method not allowed' });
  if (!SB || !KEY) return J(500, { error: 'Server is not set up yet.' });
  if (String(env('SIGNUPS_OPEN') || 'true').toLowerCase() === 'false')
    return J(403, { error: 'New signups are turned off right now. Please ask the owner.' });
  const ip = req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) return J(429, { error: 'Too many tries. Please wait a while and try again.' });

  let b = {};
  try { b = await req.json(); } catch (e) {}
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || email.length > 254) return J(400, { error: 'Please enter a valid email address.' });
  if (password.length < 8 || password.length > 72) return J(400, { error: 'Password must be 8 to 72 characters.' });

  const r = await fetch(SB + '/auth/v1/admin/users', {
    method: 'POST', headers, body: JSON.stringify({ email, password, email_confirm: true })
  });
  if (r.ok) return J(200, { ok: true });
  const e = await r.json().catch(() => ({}));
  const text = JSON.stringify(e).toLowerCase();
  if (r.status === 422 && (text.includes('exists') || text.includes('already'))) {
    // account exists: make sure an old unconfirmed one can sign in, without touching its password
    const p = await fetch(`${SB}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id`, { headers });
    const rows = await p.json().catch(() => []);
    if (Array.isArray(rows) && rows[0] && rows[0].id) {
      await fetch(`${SB}/auth/v1/admin/users/${encodeURIComponent(rows[0].id)}`, {
        method: 'PUT', headers, body: JSON.stringify({ email_confirm: true })
      });
    }
    return J(200, { ok: true, existing: true });
  }
  console.error('signup failed', r.status, text.slice(0, 200));
  return J(500, { error: 'Could not create the account. Please try again.' });
};

export const config = { path: '/api/signup' };
