// Post Machine - Discover API Routes for Vercel

import { getCache, setCache } from '../lib/db.js';
import { apiLogger, logRequest, logError } from '../lib/logger.js';

export default async function handler(request) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname.replace('/api/discover', '');

  let userId = null;
  let sessionId = null;

  try {
    // Extract session from cookie
    const cookie = request.headers.get('cookie');
    if (cookie) {
      const sessionCookie = cookie.split(';').find(c => c.trim().startsWith('session='));
      if (sessionCookie) {
        sessionId = sessionCookie.split('=')[1].trim();
        // TODO: Validate session
      }
    }

    if (method === 'GET' && path === '/articles') {
      return await handleGetArticles(request, startTime, sessionId);
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

async function handleGetArticles(request, startTime, sessionId) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 100);
  const offset = parseInt(url.searchParams.get('offset')) || 0;

  try {
    // Check cache first
    const cacheKey = `discover:articles:${query}:${limit}:${offset}`;
    let articles = null;

    if (process.env.REDIS_URL) {
      const { Redis } = await import('@upstash/redis');
      const redis = new Redis({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
      articles = await getCache(redis, cacheKey);
    }

    if (!articles) {
      // Fetch articles from external sources (placeholder implementation)
      articles = await fetchArticlesFromSources(query, limit, offset);

      // Cache the results
      if (process.env.REDIS_URL) {
        const { Redis } = await import('@upstash/redis');
        const redis = new Redis({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
        await setCache(redis, cacheKey, articles, 1800); // Cache for 30 minutes
      }
    }

    const response = new Response(JSON.stringify({ articles }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    await logRequest(request, response, startTime, null, sessionId);

    return response;

  } catch (error) {
    await logError(error, request, null, sessionId);
    return new Response(JSON.stringify({ error: 'Failed to fetch articles' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function fetchArticlesFromSources(query, limit, offset) {
  // Placeholder implementation - in a real app, this would integrate with
  // news APIs, RSS feeds, or other content sources

  const mockArticles = [
    {
      id: '1',
      title: 'The Future of AI in Software Development',
      url: 'https://example.com/ai-future',
      description: 'Exploring how artificial intelligence is transforming the way we build software.',
      source: 'Tech News',
      publishedAt: new Date().toISOString(),
      tags: ['AI', 'Software Development', 'Technology']
    },
    {
      id: '2',
      title: 'Building Scalable Web Applications',
      url: 'https://example.com/scalable-apps',
      description: 'Best practices for creating web applications that can handle millions of users.',
      source: 'Dev Blog',
      publishedAt: new Date().toISOString(),
      tags: ['Web Development', 'Scalability', 'Architecture']
    }
  ];

  // Filter by query if provided
  let filtered = mockArticles;
  if (query) {
    const lowerQuery = query.toLowerCase();
    filtered = mockArticles.filter(article =>
      article.title.toLowerCase().includes(lowerQuery) ||
      article.description.toLowerCase().includes(lowerQuery) ||
      article.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }

  // Apply pagination
  return filtered.slice(offset, offset + limit);
}