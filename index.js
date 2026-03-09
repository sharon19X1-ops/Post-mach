/**
 * Post Machine — Cloudflare Worker Entry Point
 * Account: e56be8a5a764432baaaea08f475f9636
 */
import { Hono }                from 'hono';
import { cors }                from 'hono/cors';
import { secureHeaders }       from 'hono/secure-headers';
import { createLogger, LOG_SOURCE, purgeLogs } from './logger.js';
import { requireAuth }         from './auth.lib.js';
import { handleRegister, handleLogin, handleLogout, handleMe } from './auth.routes.js';
import { handleDiscover }      from './discover.js';
import { handleArticle }       from './article.js';
import { handleShareEmail, handleShareTelegram } from './share.js';

const app = new Hono();

// ── Validation middleware: ensure critical env vars are set ────────
app.use('*', async (ctx, next) => {
  // Check required config on first request (lazy initialization)
  if (!ctx.get('configValidated')) {
    const required = ['ALLOWED_ORIGIN', 'JWT_SECRET'];
    const missing = required.filter(key => !ctx.env[key] || 
      (ctx.env[key].includes('REPLACE_WITH_') && ctx.env.APP_ENV !== 'development'));
    
    if (missing.length > 0) {
      console.error('[ERROR] Missing critical environment variables:', missing);
      ctx.set('configValidated', false);
      return ctx.json({ error: 'Server misconfigured' }, 500);
    }
    
    ctx.set('configValidated', true);
  }
  await next();
});

// ── Security headers ──────────────────────────────────────────────
app.use('*', secureHeaders());

// ── CORS ──────────────────────────────────────────────────────────
app.use('/api/*', async (ctx, next) => {
  const origin = ctx.env.ALLOWED_ORIGIN;
  if (!origin) {
    return ctx.json({ error: 'Server misconfigured: ALLOWED_ORIGIN not set' }, 500);
  }
  return cors({
    origin,
    allowMethods:  ['GET','POST','OPTIONS'],
    allowHeaders:  ['Content-Type','X-Session-Id'],
    credentials:   true,
    maxAge:        86400,
  })(ctx, next);
});

// ── Global middleware: request logger + context ───────────────────
app.use('/api/*', async (ctx, next) => {
  const requestId = crypto.randomUUID();
  const log = createLogger(ctx.env, {
    source:    LOG_SOURCE.MIDDLEWARE,
    requestId,
    sessionId: ctx.req.header('X-Session-Id') ?? 'anon',
  });

  ctx.set('log',       log);
  ctx.set('requestId', requestId);

  const start = Date.now();
  await next();

  log.http(ctx.req.raw, ctx.res, Date.now() - start);
});

// ── Body size guard ───────────────────────────────────────────────
app.use('/api/*', async (ctx, next) => {
  const maxBytes = Number(ctx.env.MAX_BODY_BYTES ?? 51200);
  const cl = Number(ctx.req.header('Content-Length') ?? 0);
  if (cl > maxBytes) {
    return ctx.json({ error: 'Request body too large' }, 413);
  }
  await next();
});

// ── Content-Type guard (POST routes) ─────────────────────────────
app.use('/api/auth/*',    contentTypeGuard);
app.use('/api/discover',  contentTypeGuard);
app.use('/api/article',   contentTypeGuard);
app.use('/api/share/*',   contentTypeGuard);

async function contentTypeGuard(ctx, next) {
  if (ctx.req.method === 'POST') {
    const ct = ctx.req.header('Content-Type') ?? '';
    if (!ct.includes('application/json')) {
      return ctx.json({ error: 'Content-Type must be application/json' }, 415);
    }
  }
  await next();
}

// ── JSON parse error handler ──────────────────────────────────────
app.use('/api/*', async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return ctx.json({ error: 'Invalid JSON in request body' }, 400);
    }
    const log = ctx.get('log');
    if (log) log.error('Unhandled Worker error', err);
    else console.error('[Worker] Unhandled error:', err);
    return ctx.json({ error: 'Service temporarily unavailable' }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTES — Public (no auth required)
// ─────────────────────────────────────────────────────────────────
app.get('/api/health', ctx => ctx.json({
  status:  'ok',
  service: ctx.env.APP_NAME ?? 'Post Machine',
  env:     ctx.env.APP_ENV  ?? 'production',
  ts:      Date.now(),
}));

app.post('/api/auth/register', handleRegister);
app.post('/api/auth/login',    handleLogin);
app.post('/api/auth/logout',   handleLogout);

// ─────────────────────────────────────────────────────────────────
// ROUTES — Protected (session required)
// ─────────────────────────────────────────────────────────────────
app.use('/api/auth/me',    requireAuth);
app.use('/api/discover',   requireAuth);
app.use('/api/article',    requireAuth);
app.use('/api/share/*',    requireAuth);
app.use('/api/admin/*',    requireAuth);

app.get ('/api/auth/me',          handleMe);
app.post('/api/discover',         handleDiscover);
app.post('/api/article',          handleArticle);
app.post('/api/share/email',      handleShareEmail);
app.post('/api/share/telegram',   handleShareTelegram);

// ── Admin / monitoring ────────────────────────────────────────────
app.get('/api/admin/logs', async ctx => {
  const { queryLogs } = await import('./logger.js');
  const level  = Number(ctx.req.query('level')  ?? 30);
  const limit  = Number(ctx.req.query('limit')  ?? 100);
  const source =        ctx.req.query('source');
  const since  = Number(ctx.req.query('since')  ?? Date.now() - 86_400_000);
  const logs   = await queryLogs(ctx.env.DB, { level, source, since, limit });
  return ctx.json({ logs, count: logs.length });
});

// ─────────────────────────────────────────────────────────────────
// 404 + 405 handlers
// ─────────────────────────────────────────────────────────────────
app.notFound(ctx => {
  const log = ctx.get('log');
  if (log) log.warn('Route not found', { path: new URL(ctx.req.url).pathname, method: ctx.req.method });
  return ctx.json({ error: 'Route not found', path: new URL(ctx.req.url).pathname }, 404);
});

app.onError((err, ctx) => {
  const log = ctx.get('log');
  if (log) log.fatal('Worker fatal error', err);
  else console.error('[Worker] Fatal:', err);
  return ctx.json({ error: 'Service temporarily unavailable' }, 500);
});

// ─────────────────────────────────────────────────────────────────
// CRON — daily log purge
// ─────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  async scheduled(event, env) {
    const log = createLogger(env, { source: LOG_SOURCE.ROUTER });
    log.info('Cron: purging old logs');
    const deleted = await purgeLogs(env.DB, 30);
    log.info('Cron: purge complete', { deletedRows: deleted });
  },
};
