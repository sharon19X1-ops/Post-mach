/**
 * Post Machine — Auth Routes
 * POST /api/auth/register
 * POST /api/auth/login
 * POST /api/auth/logout
 * GET  /api/auth/me
 */
import { z }                             from 'zod';
import { createLogger, LOG_SOURCE }      from '../lib/logger.js';
import {
  hashPassword, verifyPassword,
  createSession, revokeSession,
  setSessionCookie, clearSessionCookie,
  getSessionIdFromCookie,
  generateId, sha256,
}                                        from '../lib/auth.js';

// ── Zod schemas ───────────────────────────────────────────────────
const RegisterSchema = z.object({
  email:        z.string().email().max(254).toLowerCase().trim(),
  displayName:  z.string().min(2).max(60).trim(),
  password:     z.string().min(8).max(128),
});

const LoginSchema = z.object({
  email:    z.string().email().max(254).toLowerCase().trim(),
  password: z.string().min(1).max(128),
});

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────
export async function handleRegister(ctx) {
  const log = ctx.get('log').child({ source: LOG_SOURCE.AUTH });

  const parsed = RegisterSchema.safeParse(await ctx.req.json());
  if (!parsed.success) {
    log.warn('Register validation failed', { errors: parsed.error.flatten() });
    return ctx.json({ error: 'Invalid input', details: parsed.error.flatten() }, 400);
  }

  const { email, displayName, password } = parsed.data;

  // Check duplicate email
  const existing = await ctx.env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email).first();

  if (existing) {
    log.warn('Register: email already exists', { emailHash: await sha256(email) });
    return ctx.json({ error: 'An account with this email already exists' }, 409);
  }

  const { hash, salt } = await hashPassword(password);
  const userId         = generateId(16);
  const now            = Date.now();

  await ctx.env.DB.prepare(`
    INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(userId, email, displayName, hash, salt, now).run();

  log.info('User registered', { userId, emailHash: await sha256(email) });

  // Auto-login after registration
  const sessionId = await createSession(ctx.env, userId, email, {
    ip:        ctx.req.header('CF-Connecting-IP'),
    userAgent: ctx.req.header('User-Agent')?.slice(0, 200),
  });

  const res = ctx.json({
    message:     'Account created successfully',
    user:        { id: userId, email, displayName },
    sessionId,
  }, 201);

  return setSessionCookie(res, sessionId, Number(ctx.env.SESSION_TTL_SECS ?? 28800));
}

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────
export async function handleLogin(ctx) {
  const log = ctx.get('log').child({ source: LOG_SOURCE.AUTH });

  const parsed = LoginSchema.safeParse(await ctx.req.json());
  if (!parsed.success) {
    return ctx.json({ error: 'Invalid input' }, 400);
  }

  const { email, password } = parsed.data;

  const user = await ctx.env.DB.prepare(
    'SELECT id, email, display_name, password_hash, password_salt, is_active FROM users WHERE email = ?'
  ).bind(email).first();

  // Always run password check to prevent timing-based user enumeration
  const dummyHash = 'dGVzdA';
  const dummySalt = 'dGVzdA';
  const isValid   = user
    ? await verifyPassword(password, user.password_hash, user.password_salt)
    : (await verifyPassword(password, dummyHash, dummySalt), false);

  if (!user || !isValid) {
    log.warn('Login failed — invalid credentials', { emailHash: await sha256(email) });
    return ctx.json({ error: 'Invalid email or password' }, 401);
  }

  if (!user.is_active) {
    log.warn('Login blocked — account disabled', { userId: user.id });
    return ctx.json({ error: 'This account has been disabled' }, 403);
  }

  // Update last_login
  await ctx.env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?')
    .bind(Date.now(), user.id).run();

  const sessionId = await createSession(ctx.env, user.id, user.email, {
    ip:        ctx.req.header('CF-Connecting-IP'),
    userAgent: ctx.req.header('User-Agent')?.slice(0, 200),
  });

  log.info('User logged in', { userId: user.id });

  const res = ctx.json({
    message:  'Login successful',
    user:     { id: user.id, email: user.email, displayName: user.display_name },
    sessionId,
  });

  return setSessionCookie(res, sessionId, Number(ctx.env.SESSION_TTL_SECS ?? 28800));
}

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────
export async function handleLogout(ctx) {
  const log       = ctx.get('log').child({ source: LOG_SOURCE.AUTH });
  const sessionId = getSessionIdFromCookie(ctx.req.raw);

  if (sessionId) {
    await revokeSession(ctx.env, sessionId);
    log.info('User logged out', { sessionId });
  }

  return clearSessionCookie(ctx.json({ message: 'Logged out successfully' }));
}

// ─────────────────────────────────────────────────────────────────
// GET /api/auth/me  (requires valid session cookie)
// ─────────────────────────────────────────────────────────────────
export async function handleMe(ctx) {
  const user = ctx.get('user'); // injected by requireAuth middleware
  const row  = await ctx.env.DB.prepare(
    'SELECT id, email, display_name, created_at, last_login FROM users WHERE id = ?'
  ).bind(user.id).first();

  if (!row) return ctx.json({ error: 'User not found' }, 404);

  return ctx.json({
    user: {
      id:          row.id,
      email:       row.email,
      displayName: row.display_name,
      createdAt:   row.created_at,
      lastLogin:   row.last_login,
    }
  });
}
