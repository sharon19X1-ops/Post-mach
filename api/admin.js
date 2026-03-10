// Post Machine - Admin API Routes for Vercel

import { getLogs } from '../lib/db.js';
import { apiLogger, logRequest, logError } from '../lib/logger.js';

export default async function handler(request) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname.replace('/api/admin', '');

  let userId = null;
  let sessionId = null;

  try {
    // Extract session from cookie
    const cookie = request.headers.get('cookie');
    if (cookie) {
      const sessionCookie = cookie.split(';').find(c => c.trim().startsWith('session='));
      if (sessionCookie) {
        sessionId = sessionCookie.split('=')[1].trim();
        // TODO: Validate admin session
      }
    }

    // Basic admin check (in production, implement proper role-based access)
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    switch (method) {
      case 'GET':
        if (path === '/logs') {
          return await handleGetLogs(request, startTime, sessionId);
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

async function handleGetLogs(request, startTime, sessionId) {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const offset = parseInt(url.searchParams.get('offset')) || 0;
  const level = url.searchParams.get('level') || 'all';
  const source = url.searchParams.get('source') || 'all';

  try {
    const logs = await getLogs(limit, offset, level, source);

    const response = new Response(JSON.stringify({ logs }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    await logRequest(request, response, startTime, null, sessionId);

    return response;

  } catch (error) {
    await logError(error, request, null, sessionId);
    return new Response(JSON.stringify({ error: 'Failed to fetch logs' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}