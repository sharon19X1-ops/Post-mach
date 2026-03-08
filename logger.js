/**
 * Post Machine — Structured Logger
 * Writes to Cloudflare D1. Fire-and-forget. Never crashes the Worker.
 */

export const LOG_LEVEL = { DEBUG:10, INFO:20, WARN:30, ERROR:40, FATAL:50 };
const LABEL = { 10:'DEBUG', 20:'INFO', 30:'WARN', 40:'ERROR', 50:'FATAL' };

export const LOG_SOURCE = {
  DISCOVER:'discover', ARTICLE:'article',
  SHARE_EMAIL:'share_email', SHARE_TELEGRAM:'share_telegram',
  AI:'ai', SEARCH:'search', CACHE:'cache', DB:'db',
  READABILITY:'readability', ROUTER:'router', MIDDLEWARE:'middleware', AUTH:'auth',
};

function ulid() {
  return Date.now().toString(36).toUpperCase().padStart(8,'0') +
    Array.from({length:10},()=>Math.floor(Math.random()*36).toString(36).toUpperCase()).join('');
}

async function writeToD1(db, e) {
  try {
    await db.prepare(`
      INSERT INTO app_logs
        (id,level,level_label,source,message,meta,user_id,session_id,
         request_id,duration_ms,status_code,error_stack,env,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      e.id, e.level, e.level_label, e.source, e.message,
      e.meta, e.user_id ?? null, e.session_id ?? null,
      e.request_id ?? null, e.duration_ms ?? null,
      e.status_code ?? null, e.error_stack ?? null,
      e.env, e.created_at
    ).run();
  } catch(err) {
    console.error('[Logger] D1 write failed:', err.message, e.id);
  }
}

export function createLogger(env, { source, sessionId, requestId, userId } = {}) {
  const appEnv   = env?.APP_ENV ?? 'production';
  const minLevel = appEnv === 'development' ? LOG_LEVEL.DEBUG : LOG_LEVEL.INFO;
  const db       = env?.DB ?? null;

  function log(level, message, meta = {}, extras = {}) {
    if (level < minLevel) return;
    const entry = {
      id: ulid(), level, level_label: LABEL[level], source, message,
      meta: Object.keys(meta).length ? JSON.stringify(meta) : null,
      user_id: userId ?? null, session_id: sessionId ?? null,
      request_id: requestId ?? null,
      duration_ms: extras.durationMs ?? null,
      status_code: extras.statusCode ?? null,
      error_stack: extras.errorObj?.stack ?? null,
      env: appEnv, created_at: Date.now(),
    };
    const ts   = new Date(entry.created_at).toISOString();
    const line = `[${ts}] ${entry.level_label.padEnd(5)} [${source}] ${message}${entry.meta ? ' | '+entry.meta : ''}`;
    if (level >= LOG_LEVEL.ERROR) console.error(line);
    else if (level >= LOG_LEVEL.WARN) console.warn(line);
    else console.log(line);
    if (db) writeToD1(db, entry);
  }

  return {
    debug: (m,x)   => log(LOG_LEVEL.DEBUG, m, x),
    info:  (m,x)   => log(LOG_LEVEL.INFO,  m, x),
    warn:  (m,x)   => log(LOG_LEVEL.WARN,  m, x),
    error: (m,e,x) => e instanceof Error ? log(LOG_LEVEL.ERROR, m, x??{}, {errorObj:e}) : log(LOG_LEVEL.ERROR, m, e??{}),
    fatal: (m,e,x) => e instanceof Error ? log(LOG_LEVEL.FATAL, m, x??{}, {errorObj:e}) : log(LOG_LEVEL.FATAL, m, e??{}),
    http:  (req, res, ms) => {
      const u = new URL(req.url);
      log(LOG_LEVEL.INFO, `${req.method} ${u.pathname}`, {
        method: req.method, path: u.pathname,
        cf_ray: req.headers.get('cf-ray'),
      }, { statusCode: res.status, durationMs: ms });
    },
    share: (ch, url, extra={}) => log(extra.error ? LOG_LEVEL.ERROR : LOG_LEVEL.INFO, `Share:${ch}`, {channel:ch, article_url:url, ...extra}),
    cache: (action, key, meta={}) => log(LOG_LEVEL.DEBUG, `Cache ${action}: ${key}`, {action,key,...meta}),
    time:  async (label, fn, meta={}) => {
      const t = Date.now();
      try { const r = await fn(); log(LOG_LEVEL.INFO,`${label} OK`,meta,{durationMs:Date.now()-t}); return r; }
      catch(e) { log(LOG_LEVEL.ERROR,`${label} FAILED`,meta,{errorObj:e,durationMs:Date.now()-t}); throw e; }
    },
    child: (extra={}) => createLogger(env, { source, sessionId, requestId, userId, ...extra }),
  };
}

export async function queryLogs(db, { level, source, sessionId, requestId, userId, since, limit=100 } = {}) {
  const c=[], b=[];
  if (level!==undefined){c.push('level>=?');b.push(level);}
  if (source)           {c.push('source=?');b.push(source);}
  if (sessionId)        {c.push('session_id=?');b.push(sessionId);}
  if (requestId)        {c.push('request_id=?');b.push(requestId);}
  if (userId)           {c.push('user_id=?');b.push(userId);}
  if (since!==undefined){c.push('created_at>=?');b.push(since);}
  const where = c.length ? `WHERE ${c.join(' AND ')}` : '';
  b.push(limit);
  const {results} = await db.prepare(`SELECT * FROM app_logs ${where} ORDER BY created_at DESC LIMIT ?`).bind(...b).all();
  return results.map(r=>({...r, meta: r.meta ? JSON.parse(r.meta) : null}));
}

export async function purgeLogs(db, days=30) {
  const cutoff = Date.now() - days * 86_400_000;
  const {meta} = await db.prepare('DELETE FROM app_logs WHERE created_at < ?').bind(cutoff).run();
  return meta.changes;
}
