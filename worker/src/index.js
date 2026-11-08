// tg-ask relay: one Telegram bot shared by a team.
//
// Computers never talk to Telegram. They call this Worker with a personal key
// (created by `tg-ask setup`), and Telegram delivers the bot's updates here
// through a webhook. Each person only ever sees their own questions.
//
// Secrets (wrangler secret put): BOT_TOKEN, WEBHOOK_SECRET, INVITE_CODE.

// Shown under a question, never stored: a typed reply is always accepted, and
// only a bare number like "2" picks that option.
const HINT_OPTIONS = 'Tap an option, or type any answer in your own words.';
const HINT_FREE = 'Type your answer.';
const EXPIRED_NOTE = '⌛ Expired. Answer in Claude Code instead.';
const ANSWERED_HERE = 'Answered on your computer';
const WAIT_SLICE_MS = 20_000; // one /wait call is held open this long at most
const WAIT_STEP_MS = 1_500;
const PAIR_TTL_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_S = 4 * 3600;
const MAX_TIMEOUT_S = 24 * 3600;
const MAX_OPEN_PER_USER = 10;
const KEEP_CLOSED_MS = 24 * 3600_000;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    try {
      if (route === 'POST /telegram') return await onWebhook(request, env);
      if (route === 'POST /setup-webhook') return await setupWebhook(request, env);
      if (route === 'POST /pair') return await pair(request, env);
      if (route === 'GET /me') return await me(request, env);
      if (route === 'POST /ask') return await ask(request, env);
      const m = pathname.match(/^\/q\/([a-z0-9]{16})\/(wait|cancel|expire)$/);
      if (m && request.method === (m[2] === 'wait' ? 'GET' : 'POST')) {
        return await { wait, cancel, expire }[m[2]](request, env, m[1]);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e.stack || String(e));
      return json({ error: 'internal error' }, 500);
    }
  },

  // Hourly: drop stale pairing links, close questions nobody is waiting on any
  // more, and delete closed questions whose computer never collected them.
  async scheduled(_event, env) {
    const now = Date.now();
    await env.DB.prepare('DELETE FROM pairings WHERE expires_at < ?').bind(now).run();
    const { results } = await env.DB.prepare(
      "SELECT * FROM questions WHERE status = 'pending' AND expires_at < ? LIMIT 25",
    ).bind(now).all();
    for (const q of results) await close(env, q, 'expired', null, EXPIRED_NOTE);
    await env.DB.prepare("DELETE FROM questions WHERE status != 'pending' AND created_at < ?")
      .bind(now - KEEP_CLOSED_MS).run();
  },
};

// ── Computer-facing API ─────────────────────────────────────────────────────

// POST /pair {invite} → {key, link}. The person opens the link and presses
// Start; the bot then links their Telegram account to this key.
async function pair(request, env) {
  const body = await readJson(request);
  if (!env.INVITE_CODE || !(await sameSecret(String(body.invite || ''), env.INVITE_CODE))) {
    return json({ error: 'wrong invite code' }, 403);
  }
  const key = randomKey();
  const code = randomId(16);
  await env.DB.prepare('INSERT INTO pairings (code, key_hash, expires_at) VALUES (?, ?, ?)')
    .bind(code, await sha256(key), Date.now() + PAIR_TTL_MS).run();
  const bot = await botUsername(env);
  return json({ key, bot, link: `https://t.me/${bot}?start=${code}`, expires_in: PAIR_TTL_MS / 1000 });
}

// GET /me → {paired, name, bot}
async function me(request, env) {
  const keyHash = await keyHashOf(request);
  if (!keyHash) return json({ error: 'missing key' }, 401);
  const user = await env.DB.prepare('SELECT name FROM users WHERE key_hash = ?').bind(keyHash).first();
  if (user) return json({ paired: true, name: user.name, bot: await botUsername(env) });
  const waiting = await env.DB.prepare('SELECT 1 FROM pairings WHERE key_hash = ? AND expires_at > ?')
    .bind(keyHash, Date.now()).first();
  if (waiting) return json({ paired: false });
  return json({ error: 'unknown key: run tg-ask setup again' }, 401);
}

// POST /ask {question, options, from, timeout} → {id}
async function ask(request, env) {
  const user = await currentUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  const question = String(body.question || '').trim();
  if (!question) return json({ error: 'the question is empty' }, 400);
  const options = (Array.isArray(body.options) ? body.options : [])
    .slice(0, 10).map((o) => String(o).trim().slice(0, 100)).filter(Boolean);
  const from = String(body.from || 'Claude Code').slice(0, 60);
  const timeoutS = Math.min(Math.max(Number(body.timeout) || DEFAULT_TIMEOUT_S, 60), MAX_TIMEOUT_S);

  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM questions WHERE tg_user_id = ? AND status = 'pending' AND expires_at > ?",
  ).bind(user.tg_user_id, Date.now()).first('n');
  if (open >= MAX_OPEN_PER_USER) {
    return json({ error: `${open} questions are already open; answer or cancel some first` }, 429);
  }

  // `text` is what stays on the message once it closes; the hint goes away.
  let text = `❓ Claude · ${from}\n\n${question.slice(0, 2800)}`;
  if (options.length) text += '\n\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const hint = options.length ? HINT_OPTIONS : HINT_FREE;

  // Store first, so a tap that beats the insert still finds its question.
  const id = randomId(16);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO questions (id, key_hash, tg_user_id, chat_id, text, options, status, created_at, expires_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).bind(id, user.key_hash, user.tg_user_id, user.chat_id, text, JSON.stringify(options), now, now + timeoutS * 1000).run();

  let sent;
  try {
    sent = await tg(env, 'sendMessage', {
      chat_id: user.chat_id,
      text: `${text}\n\n${hint}`,
      reply_markup: options.length
        ? { inline_keyboard: options.map((o, i) => [{ text: `${i + 1}. ${o}`.slice(0, 64), callback_data: `q:${id}:${i}` }]) }
        : undefined,
    });
  } catch (e) {
    await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(id).run();
    return json({ error: `Telegram refused the message: ${e.message}` }, 502);
  }
  await env.DB.prepare('UPDATE questions SET message_id = ? WHERE id = ?').bind(sent.message_id, id).run();
  return json({ id });
}

// GET /q/:id/wait → {status, answer}. Held open up to WAIT_SLICE_MS; the
// computer calls again while the status is still "pending".
async function wait(request, env, id) {
  const keyHash = await keyHashOf(request);
  if (!keyHash) return json({ error: 'missing key' }, 401);
  const started = Date.now();
  for (;;) {
    const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND key_hash = ?').bind(id, keyHash).first();
    if (!q) return json({ status: 'gone' });
    if (q.status !== 'pending') {
      await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(id).run();
      return json({ status: q.status, answer: q.answer });
    }
    if (q.expires_at < Date.now()) {
      await close(env, q, 'expired', null, EXPIRED_NOTE);
      continue;
    }
    if (Date.now() - started > WAIT_SLICE_MS) return json({ status: 'pending' });
    await sleep(WAIT_STEP_MS);
  }
}

// POST /q/:id/cancel {note}: answered in the Claude session instead.
async function cancel(request, env, id) {
  const q = await ownQuestion(request, env, id);
  if (q instanceof Response) return q;
  const note = String((await readJson(request)).note || ANSWERED_HERE).slice(0, 200);
  await close(env, q, 'cancelled', null, `✓ ${note}`);
  return json({ ok: true });
}

// POST /q/:id/expire: the computer stopped waiting.
async function expire(request, env, id) {
  const q = await ownQuestion(request, env, id);
  if (q instanceof Response) return q;
  await close(env, q, 'expired', null, EXPIRED_NOTE);
  return json({ ok: true });
}

// ── Telegram webhook ────────────────────────────────────────────────────────

// POST /setup-webhook (Bearer WEBHOOK_SECRET): points the bot at this Worker,
// so deploy.sh never needs the bot token after the first run.
async function setupWebhook(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.WEBHOOK_SECRET || !(await sameSecret(auth, `Bearer ${env.WEBHOOK_SECRET}`))) {
    return json({ error: 'forbidden' }, 403);
  }
  const url = `${new URL(request.url).origin}/telegram`;
  await tg(env, 'setWebhook', {
    url,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  return json({ ok: true, webhook: url, bot: await botUsername(env) });
}

async function onWebhook(request, env) {
  if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json();
  try {
    if (update.callback_query) await onButton(env, update.callback_query);
    else if (update.message) await onMessage(env, update.message);
  } catch (e) {
    console.error(e.stack || String(e));
  }
  return new Response('ok'); // always 200, or Telegram keeps re-sending the update
}

async function onButton(env, cq) {
  const [, id, idx] = String(cq.data || '').split(':');
  const q = id ? await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first() : null;
  const options = q ? JSON.parse(q.options) : [];
  const i = Number(idx);
  const live = q && q.status === 'pending' && q.expires_at > Date.now();
  if (live && cq.from.id === q.tg_user_id && Number.isInteger(i) && i >= 0 && i < options.length) {
    if (await close(env, q, 'answered', options[i], `✓ ${options[i]}`)) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Got you!' });
      return;
    }
  }
  if (q && q.status === 'pending' && !live) await close(env, q, 'expired', null, EXPIRED_NOTE);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'This question is closed.' });
}

async function onMessage(env, m) {
  if (m.chat?.type !== 'private' || !m.from) return;
  const text = (m.text || m.caption || '').trim();
  const say = (t, replyTo = true) =>
    tg(env, 'sendMessage', {
      chat_id: m.chat.id,
      text: t,
      ...(replyTo ? { reply_parameters: { message_id: m.message_id } } : {}),
    });

  if (/^\/start(\s|$)/.test(text)) return start(env, m, text.split(/\s+/)[1], say);

  const known = await env.DB.prepare('SELECT 1 FROM users WHERE tg_user_id = ? LIMIT 1').bind(m.from.id).first();
  if (!known) return; // strangers get nothing

  const { results: open } = await env.DB.prepare(
    "SELECT * FROM questions WHERE tg_user_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at",
  ).bind(m.from.id, Date.now()).all();

  let q;
  const replyTo = m.reply_to_message?.message_id;
  if (replyTo) {
    q = open.find((x) => x.message_id === replyTo);
    if (!q) return say('That one is closed. Reply to an open question, or tap an option.');
  } else if (open.length === 1) {
    q = open[0];
  } else if (!open.length) {
    return say('Nothing is waiting for an answer right now.');
  } else {
    return say(`${open.length} questions are open. Reply to the one you mean, or tap an option.`);
  }

  if (!text) return say('Please type the answer as text.');
  const options = JSON.parse(q.options);
  const n = /^\d+$/.test(text) ? Number(text) : 0;
  const answer = n >= 1 && n <= options.length ? options[n - 1] : text;
  if (await close(env, q, 'answered', answer, `✓ ${answer.slice(0, 500)}`)) await say('Got you!');
}

async function start(env, m, code, say) {
  if (code) {
    const p = await env.DB.prepare('SELECT * FROM pairings WHERE code = ? AND expires_at > ?')
      .bind(code, Date.now()).first();
    if (!p) return say('This link has expired. Run tg-ask setup on your computer again.', false);
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || String(m.from.id);
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO users (key_hash, tg_user_id, chat_id, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(p.key_hash, m.from.id, m.chat.id, name, Date.now()),
      env.DB.prepare('DELETE FROM pairings WHERE code = ?').bind(code),
    ]);
    return say(
      'Connected. When a Claude Code session on your computer needs an answer, the question shows up here too. ' +
        'Answer here or there, whichever is faster.',
      false,
    );
  }
  const known = await env.DB.prepare('SELECT 1 FROM users WHERE tg_user_id = ? LIMIT 1').bind(m.from.id).first();
  return say(
    known
      ? 'You are connected. Questions from Claude Code show up here.'
      : 'To connect, run tg-ask setup on your computer and open the link it prints.',
    false,
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Moves a pending question to its final state exactly once (two answers racing
// can't both win), blanks the stored text, then shows the outcome under the
// Telegram message and removes its buttons.
async function close(env, q, status, answer, note) {
  const res = await env.DB.prepare(
    "UPDATE questions SET status = ?, answer = ?, text = '' WHERE id = ? AND status = 'pending'",
  ).bind(status, answer, q.id).run();
  if (!res.meta.changes) return false;
  if (q.message_id) {
    try {
      await tg(env, 'editMessageText', {
        chat_id: q.chat_id,
        message_id: q.message_id,
        text: `${q.text}\n\n${note}`,
      });
    } catch (e) {
      console.error(e.message);
    }
  }
  return true;
}

async function tg(env, method, params) {
  // TELEGRAM_API is only set by the local tests, to point at a fake Telegram.
  const base = env.TELEGRAM_API || 'https://api.telegram.org';
  const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${method}: ${body.error_code} ${body.description}`);
  return body.result;
}

let cachedBot = null;
async function botUsername(env) {
  cachedBot ??= (await tg(env, 'getMe', {})).username;
  return cachedBot;
}

async function currentUser(request, env) {
  const keyHash = await keyHashOf(request);
  const user = keyHash ? await env.DB.prepare('SELECT * FROM users WHERE key_hash = ?').bind(keyHash).first() : null;
  return user || json({ error: 'not connected: run tg-ask setup' }, 401);
}

async function ownQuestion(request, env, id) {
  const keyHash = await keyHashOf(request);
  if (!keyHash) return json({ error: 'missing key' }, 401);
  const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND key_hash = ?').bind(id, keyHash).first();
  return q || json({ error: 'no such question' }, 404);
}

async function keyHashOf(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') && h.length > 27 ? sha256(h.slice(7)) : null;
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sameSecret(a, b) {
  const enc = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [x, y] = await Promise.all([enc(a), enc(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function randomId(n) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % 36]).join('');
}

function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
