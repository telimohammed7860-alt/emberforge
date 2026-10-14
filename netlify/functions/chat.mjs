// Emberforge backend for Netlify (Functions v2, streaming). Verifies login, enforces the daily limit, streams the AI reply (Gemini via its OpenAI-compatible API).
const env = (k) => (typeof Netlify !== 'undefined' ? Netlify.env.get(k) : process.env[k]);
const SB = (env('SUPABASE_URL') || '').replace(/\/$/, '');
const KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const MODELS = {
  fast: { id: env('AI_MODEL_FAST') || 'gemini-flash-lite-latest', max: 8000 },
  balanced: { id: env('AI_MODEL_BALANCED') || 'gemini-flash-latest', max: 16000 },
  max: { id: env('AI_MODEL_MAX') || 'gemini-flash-latest', max: 16000 }
};
function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') out.push({ role: m.role, content: m.content });
    else out.push({ role: m.role, content: m.content.map(b => b.type === 'text'
      ? { type: 'text', text: b.text }
      : { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }) });
  }
  return out;
}
const BASE = "You are Emberforge, an AI assistant that builds websites and apps and writes high-level code. Reply in the same language the user writes in (Hindi, Hinglish, English, etc.) and keep explanations simple and direct. Make sensible assumptions instead of asking many questions. Always write complete, working code, never placeholders like 'rest of the code here'. ";
const MODES = {
  website: BASE + "Task: build a website. Output ONE complete, self-contained, responsive HTML file (inline CSS and JS) in a single ```html block. Use modern, distinctive design, real-sounding copy (no lorem ipsum), good accessibility. Use CDN libraries only when really needed. After the code, add 2-4 short lines on what you built and how to customise it.",
  app: BASE + "Task: build an app. Give a very short plan, then the complete code. For small apps prefer a single HTML file. For bigger ones give each file in its own fenced block with the file path as a comment on the first line, then numbered setup steps.",
  code: BASE + "Task: write or improve code. Give correct, production-quality code in fenced blocks with the language tag, and explain key decisions briefly.",
  debug: BASE + "Task: debug. Find the root cause first and say it in one or two sentences, then give the minimal fix as a code block, then how to verify it."
};
const J = (code, obj, extra) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json', ...(extra || {}) } });
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
export default async (req) => {
  if (!SB || !KEY || !env('GEMINI_API_KEY'))
    return J(500, { error: 'Server is not set up yet. Add the 3 environment variables (GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) in Netlify and redeploy.' });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!token) return J(401, { error: 'Please sign in.' });
  const user = await getUser(token);
  if (!user || !user.id) return J(401, { error: 'Session expired. Please sign in again.' });
  if (req.method === 'GET') return J(200, await rpc('get_usage', { p_user: user.id }));
  if (req.method !== 'POST') return J(405, { error: 'Method not allowed' });

  let body = {};
  try { body = await req.json(); } catch (e) {}
  const messages = clean(body.messages);
  if (!messages) return J(400, { error: 'Invalid messages.' });
  const model = MODELS[body.model] || MODELS.balanced;
  const system = MODES[body.mode] || MODES.code;

  const q = await rpc('consume_message', { p_user: user.id });
  if (q.allowed === undefined) return J(500, { error: 'Usage check failed. Did you run schema.sql?' });
  if (!q.allowed) {
    const h = Math.floor((q.reset || 0) / 3600), m = Math.ceil(((q.reset || 0) % 3600) / 60);
    const wait = h > 0 ? `${h} h ${m} min` : `${Math.max(m, 1)} min`;
    return J(429, { error: `Message limit reached (${q.limit} per 5 hours${q.busy ? ', lowered because many people are using Emberforge right now' : ''}). You can send again in about ${wait}.` });
  }

  const base = (env('AI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
  try {
    const candidates = [...new Set([model.id, 'gemini-flash-lite-latest', 'gemini-flash-latest'])];
    let up, lastRaw = '';
    for (let i = 0; i < candidates.length; i++) {
      up = await fetch(base + '/chat/completions', {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + env('GEMINI_API_KEY') },
        body: JSON.stringify({ model: candidates[i], max_tokens: model.max, stream: true, messages: toOpenAI(system, messages) })
      });
      if (up.ok) break;
      lastRaw = await up.text();
      // busy / overloaded: wait a moment and try the next model
      if (![429, 500, 502, 503, 504].includes(up.status) || i === candidates.length - 1) break;
      await new Promise(r => setTimeout(r, 800));
    }
    if (!up.ok) {
      await rpc('refund_message', { p_user: user.id });
      let msg = 'AI service error. Try again.';
      try { const e = JSON.parse(lastRaw); const x = Array.isArray(e) ? e[0] : e; if (x && x.error && x.error.message) msg = x.error.message; } catch (e) {}
      return J(502, { error: msg.slice(0, 300) });
    }
    const enc = new TextEncoder(), dec = new TextDecoder();
    const out = new ReadableStream({
      async start(ctrl) {
        const emit = (o) => { try { ctrl.enqueue(enc.encode('data: ' + JSON.stringify(o) + '\n\n')); } catch (e) {} };
        const rd = up.body.getReader();
        let buf = '';
        try {
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const l of lines) {
              if (!l.startsWith('data:')) continue;
              const d = l.slice(5).trim();
              if (!d || d === '[DONE]') continue;
              let j; try { j = JSON.parse(d); } catch (e) { continue; }
              const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (t) emit({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } });
              else if (j.error) emit({ type: 'error', error: { message: j.error.message || 'AI error' } });
            }
          }
        } catch (e) { emit({ type: 'error', error: { message: 'Connection lost. Try again.' } }); }
        try { ctrl.close(); } catch (e) {}
      }
    });
    return new Response(out, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Used': String(q.used), 'X-Limit': String(q.limit), 'X-Reset': String(q.reset || 0), 'X-Busy': String(!!q.busy) }
    });
  } catch (e) {
    await rpc('refund_message', { p_user: user.id });
    return J(500, { error: 'Something went wrong. Try again.' });
  }
};

export const config = { path: '/api/chat' };
