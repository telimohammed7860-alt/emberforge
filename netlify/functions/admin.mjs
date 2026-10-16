// Emberforge owner panel backend. Only the account marked is_owner in the database can use it.
const env = (k) => (typeof Netlify !== 'undefined' ? Netlify.env.get(k) : process.env[k]);
const SB = (env('SUPABASE_URL') || '').replace(/\/$/, '');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const J = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });
async function getUser(token) {
  const r = await fetch(SB + '/auth/v1/user', { headers: { apikey: KEY, Authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
}
async function isOwner(id) {
  const r = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=is_owner`, {
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
  });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0] && rows[0].is_owner === true;
}
async function rpc(name, args) {
  const r = await fetch(SB + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  });
  return r.json().catch(() => null);
}
export default async (req) => {
  if (!SB || !KEY) return J(500, { error: 'Server is not set up yet.' });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!token) return J(401, { error: 'Please sign in.' });
  const user = await getUser(token);
  if (!user || !user.id) return J(401, { error: 'Session expired. Please sign in again.' });
  if (!(await isOwner(user.id))) return J(403, { error: 'Owner only.' });

  if (req.method === 'GET') {
    const rows = await rpc('admin_users', {});
    return J(200, Array.isArray(rows) ? rows : []);
  }
  if (req.method !== 'POST') return J(405, { error: 'Method not allowed' });

  let b = {};
  try { b = await req.json(); } catch (e) {}
  if (b.action !== 'set_plan') return J(400, { error: 'Unknown action.' });
  const email = typeof b.email === 'string' ? b.email.trim().slice(0, 200) : '';
  const plan = b.plan === 'pro' ? 'pro' : b.plan === 'free' ? 'free' : '';
  const days = Math.max(1, Math.min(parseInt(b.days, 10) || 30, 3650));
  if (!email || !plan) return J(400, { error: 'Email and plan are required.' });
  let msg = await rpc('set_plan', { p_email: email, p_plan: plan, p_days: days, p_by: user.email || user.id });
  if (typeof msg !== 'string') msg = await rpc('set_plan', { p_email: email, p_plan: plan, p_days: days }); // older database without the log column
  return J(200, { message: typeof msg === 'string' ? msg : 'Could not change the plan.' });
};

export const config = { path: '/api/admin' };
