// Post Machine - Database Utilities for Neon Postgres

const { Client } = require('@neondatabase/serverless');

function getClient() {
  return new Client({ connectionString: process.env.DATABASE_URL });
}

// ── User Operations ──────────────────────────────────────────────
export async function createUser(email, displayName, passwordHash) {
  const client = getClient();
  const userId = generateId(16);
  const now = new Date();

  try {
    await client.connect();
    await client.query(
      `INSERT INTO users (id, email, display_name, password_hash, is_active, created_at)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [userId, email, displayName, passwordHash, now]
    );
    return userId;
  } finally {
    await client.end();
  }
}

export async function getUserByEmail(email) {
  const client = getClient();
  try {
    await client.connect();
    const result = await client.query(
      `SELECT id, email, display_name, password_hash, is_active, created_at, last_login
       FROM users WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
  } finally {
    await client.end();
  }
}

export async function getUserById(id) {
  const client = getClient();
  try {
    await client.connect();
    const result = await client.query(
      `SELECT id, email, display_name, created_at, last_login
       FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  } finally {
    await client.end();
  }
}

export async function updateUserLastLogin(id) {
  const client = getClient();
  try {
    await client.connect();
    await client.query(
      `UPDATE users SET last_login = $1 WHERE id = $2`,
      [new Date(), id]
    );
  } finally {
    await client.end();
  }
}

// ── Session Operations ───────────────────────────────────────────
export async function logSession(sessionId, userId, userEmail, ip, userAgent) {
  const client = getClient();
  const now = new Date();
  const ttl = Number(process.env.SESSION_TTL_SECS ?? 28800);
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  try {
    await client.connect();
    await client.query(
      `INSERT INTO sessions (id, user_id, user_email, ip_address, user_agent, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, userId, userEmail, ip, userAgent, now, expiresAt]
    );
  } finally {
    await client.end();
  }
}

export async function getSession(sessionId) {
  const client = getClient();
  try {
    await client.connect();
    const result = await client.query(
      `SELECT s.*, u.display_name
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.expires_at > $2 AND s.revoked = false`,
      [sessionId, new Date()]
    );
    return result.rows[0] || null;
  } finally {
    await client.end();
  }
}

export async function revokeSession(sessionId) {
  const client = getClient();
  try {
    await client.connect();
    await client.query(
      `UPDATE sessions SET revoked = true WHERE id = $1`,
      [sessionId]
    );
  } finally {
    await client.end();
  }
}

// ── Share Operations ─────────────────────────────────────────────
export async function logShare(userId, sessionId, articleUrl, articleTitle, channel, recipient, messageId) {
  const client = getClient();
  try {
    await client.connect();
    await client.query(
      `INSERT INTO share_log (id, user_id, session_id, article_url, article_title, channel, recipient, message_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [generateId(16), userId, sessionId, articleUrl, articleTitle, channel, recipient, messageId, new Date()]
    );
  } finally {
    await client.end();
  }
}

// ── Admin Operations ─────────────────────────────────────────────
export async function getLogs(limit = 100, offset = 0, level = 'all', source = 'all') {
  const client = getClient();
  try {
    await client.connect();

    let query = `SELECT * FROM app_logs WHERE 1=1`;
    const params = [];
    let paramIndex = 1;

    if (level !== 'all') {
      query += ` AND level_label = $${paramIndex}`;
      params.push(level);
      paramIndex++;
    }

    if (source !== 'all') {
      query += ` AND source = $${paramIndex}`;
      params.push(source);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await client.query(query, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

// ── Logging Operations ───────────────────────────────────────────
export async function logToDB(level, levelLabel, source, message, meta, userId, sessionId, requestId, durationMs, statusCode, errorStack) {
  const client = getClient();
  const now = new Date();

  try {
    await client.connect();
    await client.query(
      `INSERT INTO app_logs (id, level, level_label, source, message, meta, user_id, session_id, request_id, duration_ms, status_code, error_stack, env, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [generateULID(), level, levelLabel, source, message, meta ? JSON.stringify(meta) : null, userId, sessionId, requestId, durationMs, statusCode, errorStack, process.env.APP_ENV, now]
    );
  } finally {
    await client.end();
  }
}

// ── Utility Functions ────────────────────────────────────────────
function generateId(bytes = 16) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function generateULID() {
  return Date.now().toString(36).toUpperCase().padStart(8,'0') +
    Array.from({length:10},()=>Math.floor(Math.random()*36).toString(36).toUpperCase()).join('');
}

// ── Cache Operations (Upstash Redis) ─────────────────────────────
export async function getCache(redis, key) {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

export async function setCache(redis, key, data, ttl = 1800) {
  try {
    await redis.set(key, JSON.stringify(data), { ex: ttl });
  } catch {
    // Silently fail
  }
}