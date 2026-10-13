// Emberforge backend (Vercel serverless, CommonJS). Verifies login, enforces the daily limit, streams Claude's reply.
const SB = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODELS = {
  fast: { id: 'claude-haiku-5-5', max: 8000 },
  balanced: { id: 'claude-sonnet-5-5', max: 16000 },
  max: { id: 'claude-opus-5-5', max: 16000 }
};
const BASE = "You are Emberforge, an AI assistant that builds websites and apps and writes high-level code. Reply in the same language the user writes in (Hindi, Hinglish, English, etc.) and keep explanations simple and direct. Make sensible assumptions instead of asking many questions. Always write complete, working code, never placeholders like 'rest of the code here'. ";
const MODES = {
  website: BASE + "Task: build a website. Output ONE complete, self-contained, responsive HTML file (inline CSS and JS) in a single ```html block. Use modern, distinctive design, real-sounding copy (no lorem ipsum), good accessibility. Use CDN libraries only when really needed. After the code, add 2-4 short lines on what you built and how to customise it.",
  app: BASE + "Task: build an app. Give a very short plan, then the complete code. For small apps prefer a single HTML file. For bigger ones give each file in its own fenced block with the file path as a comment on the first line, then numbered setup steps.",
  code: BASE + "Task: write or improve code. Give correct, production-quality code in fenced blocks with the language tag, and explain key decisions briefly.",
  debug: BASE + "Task: debug. Find the root cause first and say it in one or two sentences, then give the minimal fix as a code block, then how to verify it."
};
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
async function getUser(token) {
  const r = await fetch(SB + '/auth/v1/user', { headers: { apikey: KEY, Authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
}
async function rpc(name, args) {
  const r = await fetch(SB + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  });
  return r.json().catch(() => ({}));
}
function clean(messages) {
  if (!Array.isArray(messages)) return null;
  const out = [];
  for (const m of messages.slice(-30)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content === 'string') {
      if (m.content.trim()) out.push({ role: m.role, content: m.content.slice(0, 200000) });
    } else if (Array.isArray(m.content) && m.role === 'user') {
      const blocks = [];
      for (const b of m.content) {
        if (b && b.type === 'text' && typeof b.text === 'string') blocks.push({ type: 'text', text: b.text.slice(0, 200000) });
        else if (b && b.type === 'image' && b.source && b.source.type === 'base64' &&
          /^image\/(png|jpeg|gif|webp)$/.test(b.source.media_type) && typeof b.source.data === 'string')
          blocks.push({ type: 'image', source: { type: 'base64', media_type: b.source.media_type, data: b.source.data } });
      }
      if (blocks.length) out.push({ role: 'user', content: blocks });
    } else return null;
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out.length && out[out.length - 1].role === 'user' ? out : null;
}
module.exports = async (req, res) => {
  if (!SB || !KEY || !process.env.ANTHROPIC_API_KEY)
    return send(res, 500, { error: 'Server is not set up yet. Add the 3 environment variables in Vercel and redeploy.' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return send(res, 401, { error: 'Please sign in.' });
  const user = await getUser(token);
  if (!user || !user.id) return send(res, 401, { error: 'Session expired. Please sign in again.' });
  if (req.method === 'GET') return send(res, 200, await rpc('get_usage', { p_user: user.id }));
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const body = req.body || {};
  const messages = clean(body.messages);
  if (!messages) return send(res, 400, { error: 'Invalid messages.' });
  const model = MODELS[body.model] || MODELS.balanced;
  const system = MODES[body.mode] || MODES.code;

  const q = await rpc('consume_message', { p_user: user.id });
  if (q.allowed === undefined) return send(res, 500, { error: 'Usage check failed. Did you run schema.sql?' });
  if (!q.allowed) return send(res, 429, { error: `Daily limit reached (${q.limit} messages). It resets at midnight IST.` });

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model.id, max_tokens: model.max, system, messages, stream: true })
    });
    if (!up.ok) {
      await rpc('refund_message', { p_user: user.id });
      const e = await up.json().catch(() => ({}));
      return send(res, 502, { error: (e.error && e.error.message) || 'AI service error. Try again.' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Used': String(q.used), 'X-Limit': String(q.limit)
    });
    for await (const chunk of up.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (!res.headersSent) { await rpc('refund_message', { p_user: user.id }); return send(res, 500, { error: 'Something went wrong. Try again.' }); }
    res.end();
  }
};
