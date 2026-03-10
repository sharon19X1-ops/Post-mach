// Post Machine - Auth API Routes for Vercel

import { createUser, getUserByEmail, updateUserLastLogin, logSession, getSession, revokeSession } from '../lib/db.js';
import { authLogger, logRequest, logError } from '../lib/logger.js';
import { hashPassword, verifyPassword, generateSessionId, validateEmail } from '../lib/auth.js';

export default async function handler(request) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname.replace('/api/auth', '');

  let userId = null;
  let sessionId = null;

  try {
    // Extract session from cookie if present
    const cookie = request.headers.get('cookie');
    if (cookie) {
      const sessionCookie = cookie.split(';').find(c => c.trim().startsWith('session='));
      if (sessionCookie) {
        sessionId = sessionCookie.split('=')[1].trim();
        const session = await getSession(sessionId);
        if (session) {
          userId = session.user_id;
        }
      }
    }

    switch (method) {
      case 'POST':
        if (path === '/register') {
          return await handleRegister(request, startTime);
        } else if (path === '/login') {
          return await handleLogin(request, startTime);
        } else if (path === '/logout') {
          return await handleLogout(request, startTime, sessionId);
        }
        break;

      case 'GET':
        if (path === '/me') {
          return await handleMe(request, startTime, sessionId);
        }
        break;
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    await logError(error, request, userId, sessionId);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleRegister(request, startTime) {
  const { email, displayName, password } = await request.json();

  if (!email || !displayName || !password) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!validateEmail(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email format' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (password.length < 8) {
    return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return new Response(JSON.stringify({ error: 'Email already registered' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const passwordHash = await hashPassword(password);
    const userId = await createUser(email, displayName, passwordHash);

    await authLogger.info('User registered', { userId, email }, userId);

    await logRequest(request, { status: 201 }, startTime);

    return new Response(JSON.stringify({
      message: 'User registered successfully',
      userId
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    await logError(error, request);
    return new Response(JSON.stringify({ error: 'Registration failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleLogin(request, startTime) {
  const { email, password } = await request.json();

  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'Missing email or password' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const user = await getUserByEmail(email);
    if (!user || !user.is_active) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const isValidPassword = await verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update last login
    await updateUserLastLogin(user.id);

    // Create session
    const sessionId = generateSessionId();
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip');
    const userAgent = request.headers.get('user-agent');

    await logSession(sessionId, user.id, user.email, ip, userAgent);

    await authLogger.info('User logged in', { userId: user.id, email }, user.id, sessionId);

    const response = new Response(JSON.stringify({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    // Set session cookie
    response.headers.set('Set-Cookie',
      `session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Max-Age=${process.env.SESSION_TTL_SECS ?? 28800}; Path=/`
    );

    await logRequest(request, response, startTime, user.id, sessionId);

    return response;

  } catch (error) {
    await logError(error, request);
    return new Response(JSON.stringify({ error: 'Login failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleLogout(request, startTime, sessionId) {
  if (sessionId) {
    try {
      await revokeSession(sessionId);
      await authLogger.info('User logged out', {}, null, sessionId);
    } catch (error) {
      await authLogger.warn('Failed to revoke session on logout', { error: error.message }, null, sessionId);
    }
  }

  const response = new Response(JSON.stringify({ message: 'Logged out successfully' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  // Clear session cookie
  response.headers.set('Set-Cookie',
    'session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/'
  );

  await logRequest(request, response, startTime);

  return response;
}

async function handleMe(request, startTime, sessionId) {
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const session = await getSession(sessionId);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const response = new Response(JSON.stringify({
      user: {
        id: session.user_id,
        email: session.user_email,
        displayName: session.display_name
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    await logRequest(request, response, startTime, session.user_id, sessionId);

    return response;

  } catch (error) {
    await logError(error, request, null, sessionId);
    return new Response(JSON.stringify({ error: 'Failed to get user info' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}