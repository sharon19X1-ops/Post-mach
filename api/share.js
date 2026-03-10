// Post Machine - Share API Routes for Vercel

import { logShare, getSession } from '../lib/db.js';
import { shareLogger, logRequest, logError } from '../lib/logger.js';

export default async function handler(request) {
  const startTime = Date.now();
  const method = request.method;

  let userId = null;
  let sessionId = null;

  try {
    // Extract session from cookie
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

    if (!sessionId || !userId) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (method === 'POST') {
      return await handleShare(request, startTime, userId, sessionId);
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
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

async function handleShare(request, startTime, userId, sessionId) {
  const { articleUrl, articleTitle, channel, recipient } = await request.json();

  if (!articleUrl || !channel) {
    return new Response(JSON.stringify({ error: 'Missing required fields: articleUrl, channel' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Here you would implement the actual sharing logic for different channels
    // For now, we'll just log the share attempt
    let messageId = null;

    if (channel === 'email') {
      // Implement email sending logic
      messageId = `email_${Date.now()}`;
    } else if (channel === 'slack') {
      // Implement Slack posting logic
      messageId = `slack_${Date.now()}`;
    } else if (channel === 'discord') {
      // Implement Discord posting logic
      messageId = `discord_${Date.now()}`;
    } else {
      return new Response(JSON.stringify({ error: 'Unsupported channel' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Log the share
    await logShare(userId, sessionId, articleUrl, articleTitle, channel, recipient, messageId);

    await shareLogger.info('Article shared', {
      articleUrl,
      articleTitle,
      channel,
      recipient,
      messageId
    }, userId, sessionId);

    const response = new Response(JSON.stringify({
      message: 'Article shared successfully',
      messageId
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    await logRequest(request, response, startTime, userId, sessionId);

    return response;

  } catch (error) {
    await logError(error, request, userId, sessionId);
    return new Response(JSON.stringify({ error: 'Failed to share article' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}