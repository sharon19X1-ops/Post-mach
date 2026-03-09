/**
 * Post Machine — Share Routes
 * POST /api/share/email
 * POST /api/share/telegram
 */
import { z }                        from 'zod';
import { createLogger, LOG_SOURCE } from './logger.js';
import { sha256, generateId }       from './auth.lib.js';

const EmailSchema = z.object({
  to:      z.string().email().max(254),
  article: z.object({
    title:  z.string().max(500),
    url:    z.string().url(),
    teaser: z.string().max(1000).optional(),
  }),
});

const TelegramSchema = z.object({
  chatId:  z.string().min(2).max(100),
  article: z.object({
    title:  z.string().max(500),
    url:    z.string().url(),
    teaser: z.string().max(1000).optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────
// POST /api/share/email
// ─────────────────────────────────────────────────────────────────
export async function handleShareEmail(ctx) {
  const user = ctx.get('user');
  const log  = ctx.get('log').child({ source: LOG_SOURCE.SHARE_EMAIL, userId: user.id });

  const parsed = EmailSchema.safeParse(await ctx.req.json().catch(() => ({})));
  if (!parsed.success) {
    return ctx.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
  }

  const { to, article } = parsed.data;
  const apiKey = ctx.env.RESEND_API_KEY;
  if (!apiKey) {
    log.fatal('RESEND_API_KEY not configured');
    return ctx.json({ error: 'Service temporarily unavailable' }, 500);
  }

  const html = buildEmailHTML(article);

  let resendRes, body;
  try {
    resendRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from:    `Post Machine <noreply@${ctx.env.ALLOWED_ORIGIN?.replace('https://','') ?? 'postmachine.app'}>`,
        to:      [to],
        subject: `[Post Machine] ${article.title.slice(0, 100)}`,
        html,
      }),
      signal: AbortSignal.timeout(8000),
    });
    body = await resendRes.json();
  } catch (err) {
    log.error('Resend API call failed', err, { to: await sha256(to) });
    return ctx.json({ error: 'Email delivery failed, please retry' }, 502);
  }

  if (!resendRes.ok) {
    log.warn('Resend rejected email', { status: resendRes.status, to: await sha256(to) });
    return ctx.json({ error: 'Email could not be delivered', detail: body?.message }, 502);
  }

  // Persist share record
  await logShare(ctx.env, {
    userId:    user.id,
    sessionId: ctx.get('sessionId'),
    url:       article.url,
    title:     article.title,
    channel:   'email',
    recipient: await sha256(to),
    messageId: body.id,
    status:    'sent',
  });

  log.share('email', article.url, { messageId: body.id });
  return ctx.json({
    success:   true,
    channel:   'email',
    messageId: body.id,
    message:   `Article sent to ${to}`,
  });
}

// ─────────────────────────────────────────────────────────────────
// POST /api/share/telegram
// ─────────────────────────────────────────────────────────────────
export async function handleShareTelegram(ctx) {
  const user = ctx.get('user');
  const log  = ctx.get('log').child({ source: LOG_SOURCE.SHARE_TELEGRAM, userId: user.id });

  const parsed = TelegramSchema.safeParse(await ctx.req.json().catch(() => ({})));
  if (!parsed.success) {
    return ctx.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
  }

  const { chatId, article } = parsed.data;
  const token = ctx.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.fatal('TELEGRAM_BOT_TOKEN not configured');
    return ctx.json({ error: 'Service temporarily unavailable' }, 500);
  }

  const text = formatTelegramMessage(article);

  let tgRes, tgBody;
  try {
    tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
      signal:  AbortSignal.timeout(8000),
    });
    tgBody = await tgRes.json();
  } catch (err) {
    log.error('Telegram API call failed', err, { chatId });
    return ctx.json({ error: 'Telegram delivery failed, please retry' }, 502);
  }

  if (!tgBody.ok) {
    const code = tgBody.error_code;
    if (code === 403) return ctx.json({ error: 'Cannot send to this recipient — bot may be blocked', code: 'BOT_BLOCKED' }, 403);
    if (code === 400) return ctx.json({ error: 'Invalid chat ID or username', code: 'INVALID_CHAT' }, 400);
    log.warn('Telegram rejected message', { errorCode: code, chatId });
    return ctx.json({ error: 'Telegram could not deliver message', detail: tgBody.description }, 502);
  }

  await logShare(ctx.env, {
    userId:    user.id,
    sessionId: ctx.get('sessionId'),
    url:       article.url,
    title:     article.title,
    channel:   'telegram',
    recipient: await sha256(chatId),
    messageId: String(tgBody.result?.message_id),
    status:    'sent',
  });

  log.share('telegram', article.url, { messageId: tgBody.result?.message_id });
  return ctx.json({
    success:   true,
    channel:   'telegram',
    messageId: tgBody.result?.message_id,
    message:   `Article sent to ${chatId}`,
  });
}

// ── Helpers ───────────────────────────────────────────────────────
async function logShare(env, { userId, sessionId, url, title, channel, recipient, messageId, status }) {
  await env.DB.prepare(`
    INSERT INTO share_log (id,user_id,session_id,article_url,article_title,channel,recipient,message_id,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(generateId(12), userId, sessionId, url, title, channel, recipient, messageId, status, Date.now())
    .run().catch(e => console.error('[share] D1 log failed:', e.message));
}

function buildEmailHTML({ title, url, teaser }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333}
h1{color:#1E3A5F;font-size:22px;line-height:1.3}
p{line-height:1.6;color:#555}
.btn{display:inline-block;background:#2E86AB;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0}
.footer{margin-top:32px;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px}
</style></head><body>
<p style="color:#2E86AB;font-weight:bold;font-size:13px;text-transform:uppercase;letter-spacing:1px">Post Machine</p>
<h1>${escapeHtml(title)}</h1>
${teaser ? `<p>${escapeHtml(teaser)}</p>` : ''}
<a class="btn" href="${url}">Read Article →</a>
<div class="footer">Shared via Post Machine. <a href="${url}">${new URL(url).hostname}</a></div>
</body></html>`;
}

function formatTelegramMessage({ title, url, teaser }) {
  const t = title.slice(0, 200).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const d = (teaser ?? '').slice(0, 300).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  return `<b>📰 ${t}</b>\n\n${d ? `${d}\n\n` : ''}<a href="${url}">Read full article →</a>\n\n<i>Shared via Post Machine</i>`;
}

function escapeHtml(s) {
  return (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
