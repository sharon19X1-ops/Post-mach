/**
 * Post Machine — Auth Library
 * ─────────────────────────────────────────────────────────────────
 * Pure Web Crypto API — zero npm deps, runs natively in CF Workers.
 *
 * Provides:
 *   hashPassword(password)              → { hash, salt }
 *   verifyPassword(password,hash,salt)  → boolean
 *   signJWT(payload, secret, ttlSecs)   → token string
 *   verifyJWT(token, secret)            → payload | null
 *   createSession(env, userId, meta)    → sessionId
 *   getSession(env, sessionId)          → session | null
 *   revokeSession(env, sessionId)       → void
 *   requireAuth middleware              → attaches user to ctx
 */

const ENC   = new TextEncoder();
const TTL   = 28800; // 8 hours default

// ── Utilities ────────────────────────────────────────────────────
function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function fromB64(str) {
  const s = str.replace(/-/g,'+').replace(/_/g,'/');
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function generateId(bytes = 32) {
  return toB64(randomBytes(bytes));
}

// ── Password hashing (PBKDF2-SHA256, 310 000 iterations) ─────────
export async function hashPassword(password) {
  const salt      = randomBytes(16);
  const keyMat    = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived   = await crypto.subtle.deriveBits(
    { name:'PBKDF2', hash:'SHA-256', salt, iterations: 310_000 },
    keyMat, 256
  );
  return { hash: toB64(derived), salt: toB64(salt) };
}

export async function verifyPassword(password, storedHash, storedSalt) {
  try {
    const salt    = fromB64(storedSalt);
    const keyMat  = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name:'PBKDF2', hash:'SHA-256', salt, iterations: 310_000 },
      keyMat, 256
    );
    // Constant-time compare
    const a = new Uint8Array(derived);
    const b = fromB64(storedHash);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch { return false; }
}

// ── JWT (HMAC-SHA256) ─────────────────────────────────────────────
async function getHMACKey(secret) {
  return crypto.subtle.importKey(
    'raw', ENC.encode(secret),
    { name:'HMAC', hash:'SHA-256' },
    false, ['sign','verify']
  );
}

export async function signJWT(payload, secret, ttlSecs = TTL) {
  const header  = toB64(ENC.encode(JSON.stringify({ alg:'HS256', typ:'JWT' })));
  const body    = toB64(ENC.encode(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSecs,
  })));
  const key = await getHMACKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, ENC.encode(`${header}.${body}`));
  return `${header}.${body}.${toB64(sig)}`;
}

export async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const key   = await getHMACKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, fromB64(sig), ENC.encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64(body)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return payload;
  } catch { return null; }
}

// ── Session Management (KV-backed, D1 audit) ─────────────────────
export async function createSession(env, userId, userEmail, meta = {}) {
  const sessionId = generateId(32);
  const now       = Date.now();
  const ttl       = Number(env.SESSION_TTL_SECS ?? TTL);
  const expiresAt = now + ttl * 1000;

  const sessionData = {
    sessionId, userId, userEmail,
    createdAt: now, expiresAt,
    ...meta,
  };

  // Write to KV (fast lookup on every request)
  await env.SESSIONS.put(
    `session:${sessionId}`,
    JSON.stringify(sessionData),
    { expirationTtl: ttl }
  );

  // Write audit row to D1 (non-blocking)
  env.DB.prepare(`
    INSERT INTO sessions (id, user_id, user_email, ip_address, user_agent, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    sessionId, userId, userEmail,
    meta.ip ?? null, meta.userAgent ?? null,
    now, expiresAt
  ).run().catch(e => console.error('[auth] session D1 write failed:', e.message));

  return sessionId;
}

export async function getSession(env, sessionId) {
  if (!sessionId) return null;
  try {
    const raw = await env.SESSIONS.get(`session:${sessionId}`);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session.expiresAt < Date.now()) {
      await env.SESSIONS.delete(`session:${sessionId}`);
      return null;
    }
    return session;
  } catch { return null; }
}

export async function revokeSession(env, sessionId) {
  await env.SESSIONS.delete(`session:${sessionId}`);
  env.DB.prepare(`UPDATE sessions SET revoked = 1 WHERE id = ?`)
    .bind(sessionId).run()
    .catch(e => console.error('[auth] revoke D1 failed:', e.message));
}

// ── Cookie helpers ────────────────────────────────────────────────
export function setSessionCookie(response, sessionId, ttlSecs = TTL) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie',
    `pm_session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSecs}; Path=/`
  );
  return new Response(response.body, { status: response.status, headers });
}

export function clearSessionCookie(response) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie',
    `pm_session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/`
  );
  return new Response(response.body, { status: response.status, headers });
}

export function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') ?? '';
  const match  = cookie.match(/pm_session=([^;]+)/);
  return match ? match[1] : null;
}

// ── Middleware: requireAuth ───────────────────────────────────────
/**
 * Hono middleware — attaches ctx.var.user and ctx.var.sessionId.
 * Returns 401 if no valid session found.
 *
 * Usage:
 *   app.use('/api/discover', requireAuth);
 *   app.use('/api/share/*',  requireAuth);
 */
export async function requireAuth(ctx, next) {
  const sessionId = getSessionIdFromCookie(ctx.req.raw);
  if (!sessionId) {
    return ctx.json({ error: 'Authentication required', code: 'UNAUTHENTICATED' }, 401);
  }

  const session = await getSession(ctx.env, sessionId);
  if (!session) {
    return ctx.json({ error: 'Session expired or invalid', code: 'SESSION_EXPIRED' }, 401);
  }

  ctx.set('user',      { id: session.userId, email: session.userEmail });
  ctx.set('sessionId', sessionId);
  await next();
}

// ── SHA-256 hash (for PII fields like email in logs) ─────────────
export async function sha256(str) {
  const digest = await crypto.subtle.digest('SHA-256', ENC.encode(str));
  return toB64(digest);
}
