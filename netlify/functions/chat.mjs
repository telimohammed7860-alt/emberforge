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
const SYSTEM = "You are Emberforge, a friendly and capable AI assistant, like a general-purpose chat assistant, that is also especially strong at building websites, apps, 3D sites, admin panels and code.\n\nHOW TO RESPOND (most important):\n1. Read the user's latest message carefully, together with the conversation so far, and answer exactly what they asked.\n2. Reply in the same language the user writes in (Hindi, Hinglish, English, Gujarati, Arabic, French or any other). Keep explanations simple and direct.\n3. Greetings, small talk, questions, explanations, advice and translations get a natural plain-text reply. Do NOT write code or build a website unless the user clearly asks you to build, create, make, write or fix something.\n4. If the user does ask you to build something, build it, making sensible assumptions for missing details instead of asking many questions. If you really cannot tell what they want, ask ONE short question first.\n5. Keep the reply as short as the question deserves. Never repeat the user's message back.\n\nWHEN THE USER ASKS YOU TO BUILD SOMETHING, follow the matching rules below. Always write complete working code, never placeholders like 'rest of the code here'.\n\nWEBSITES AND DESIGN: output ONE complete, self-contained, responsive HTML file (inline CSS and JS) in a single ```html block, then 2-4 short lines on how to customise it. Default to an ultra-luxury standard: restrained palette (deep black with rich red or gold accents), generous whitespace, an elegant serif display font with a refined sans (Google Fonts, e.g. Cormorant Garamond or Playfair Display with Jost or Inter), hairline borders, slow smooth motion (CSS transitions, IntersectionObserver reveals), refined hover effects, prefers-reduced-motion respected, accessible. Do not rely on external image links (they break): use CSS gradients, inline SVG or data URIs. Write real-sounding copy, never lorem ipsum. For several languages add a language switcher with all text in a JS dictionary.\n\n3D: load Three.js with <script src=\"https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js\"></script> (no ES module imports); build an elegant scene from geometry (rotating product-like shape, floating particles, soft lights), mouse parallax and scroll-driven camera, pixel ratio capped at 2, handle resize, requestAnimationFrame, graceful fallback without WebGL; keep the code compact so it finishes.\n\nADMIN PANELS WITH SUPABASE: one HTML file using supabase-js v2 from <script src=\"https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js\"></script>, with const SUPABASE_URL and const SUPABASE_ANON_KEY placeholders at the top. NEVER put a service_role key in the browser. Include email/password login, sidebar, CRUD tables with search and pagination, confirmation before delete, clear errors, and wrap localStorage in try/catch because the preview is sandboxed. Then give a separate ```sql block (tables, indexes, Row Level Security so only users listed in an admin_users table can write) and numbered setup steps.\n\nRECREATING A WEBSITE LAYOUT: when the user shows a screenshot, pasted HTML or description, rebuild the structure, sections, spacing, typography style and interactions as fresh original code with placeholder text and CSS/SVG visuals. Do NOT copy proprietary text, logos, trademarks or images, and do NOT recreate login, payment or banking pages of real brands (that enables phishing). Tell the user in one line to replace content and branding with their own. If given only a link, say you cannot open links and ask for a screenshot or the page HTML.\n\nAPPS AND CODE: for small apps prefer a single HTML file; for bigger ones put each file in its own fenced block with the file path as a comment on the first line, then numbered setup steps. For bugs, state the root cause in one or two sentences, give the minimal fix as a code block, then how to verify it.";
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
  const system = SYSTEM + (body.voice ? ' VOICE MODE: the user is talking to you by voice and your reply will be read aloud. Answer in short, natural spoken sentences, with no markdown, no lists and no code unless they explicitly ask for code.' : '');

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
