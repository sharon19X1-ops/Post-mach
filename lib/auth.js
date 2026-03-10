// Post Machine - Authentication Utilities for Vercel
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ── Password hashing (bcrypt) ─────────────────────────────────────
export async function hashPassword(password) {
  const saltRounds = 12;
  const hash = await bcrypt.hash(password, saltRounds);
  return { hash };
}

export async function verifyPassword(password, storedHash) {
  return await bcrypt.compare(password, storedHash);
}

// ── JWT (jsonwebtoken library) ────────────────────────────────────
export async function signJWT(payload, secret, ttlSecs = 28800) {
  return jwt.sign(payload, secret, { expiresIn: ttlSecs });
}

export async function verifyJWT(token, secret) {
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

// ── Session Management (Upstash Redis) ───────────────────────────────
export async function createSession(redis, userId, userEmail, meta = {}) {
  const sessionId = generateId(32);
  const now = Date.now();
  const ttl = Number(process.env.SESSION_TTL_SECS ?? 28800);
  const expiresAt = now + ttl * 1000;

  const sessionData = {
    sessionId, userId, userEmail,
    createdAt: now, expiresAt,
    ...meta,
  };

  // Store in Upstash Redis
  await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), { ex: ttl });

  return sessionId;
}

export async function getSession(redis, sessionId) {
  if (!sessionId) return null;
  try {
    const raw = await redis.get(`session:${sessionId}`);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session.expiresAt < Date.now()) {
      await redis.del(`session:${sessionId}`);
      return null;
    }
    return session;
  } catch { return null; }
}

export async function revokeSession(redis, sessionId) {
  await redis.del(`session:${sessionId}`);
}

// ── Rate Limiting ────────────────────────────────────────────────
const rateLimitStore = new Map();

export function checkRateLimit(identifier, maxRequests = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const key = `${identifier}`;
  const windowStart = now - windowMs;

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, []);
  }

  const requests = rateLimitStore.get(key);
  // Remove old requests outside the window
  const validRequests = requests.filter(time => time > windowStart);

  if (validRequests.length >= maxRequests) {
    return { allowed: false, resetTime: validRequests[0] + windowMs };
  }

  validRequests.push(now);
  rateLimitStore.set(key, validRequests);

  return { allowed: true };
}

// ── Cookie helpers ────────────────────────────────────────────────
export function setSessionCookie(response, sessionId, ttlSecs = 28800) {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie',
    `pm_session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSecs}; Path=/`
  );
  return new Response(response.body, { status: response.status, headers });
}

export function getSessionIdFromCookie(request) {
  const cookies = request.headers?.get('cookie') || '';
  const match = cookies.match(/pm_session=([^;]+)/);
  return match ? match[1] : null;
}

// ── Middleware: requireAuth ───────────────────────────────────────
export async function requireAuth(redis, request) {
  const sessionId = getSessionIdFromCookie(request);
  if (!sessionId) {
    return { error: 'Authentication required', code: 'UNAUTHENTICATED', status: 401 };
  }

  const session = await getSession(redis, sessionId);
  if (!session) {
    return { error: 'Session expired or invalid', code: 'SESSION_EXPIRED', status: 401 };
  }

  // Get user from database
  const { getUserById } = require('./db.js');
  const user = await getUserById(session.userId);
  if (!user) {
    return { error: 'User not found', status: 401, code: 'USER_NOT_FOUND' };
  }

  return { user, sessionId };
}

// ── SHA-256 hash ─────────────────────────────────────────────────
export async function sha256(str) {
  return require('crypto').createHash('sha256').update(str).digest('base64url');
}

// ── Utility Functions ────────────────────────────────────────────
function generateId(bytes = 16) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}