// Post Machine - Article API Routes for Vercel

import { getCache, setCache } from '../lib/db.js';
import { apiLogger, logRequest, logError } from '../lib/logger.js';

export default async function handler(request) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname.replace('/api/article', '');

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

    if (method === 'GET' && path.startsWith('/')) {
      const articleUrl = decodeURIComponent(path.substring(1));
      return await handleGetArticle(request, startTime, articleUrl, sessionId);
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

async function handleGetArticle(request, startTime, articleUrl, sessionId) {
  if (!articleUrl) {
    return new Response(JSON.stringify({ error: 'Article URL required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Check cache first
    const cacheKey = `article:${articleUrl}`;
    let article = null;

    if (process.env.REDIS_URL) {
      const { Redis } = await import('@upstash/redis');
      const redis = new Redis({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
      article = await getCache(redis, cacheKey);
    }

    if (!article) {
      // Fetch and parse article content
      article = await fetchAndParseArticle(articleUrl);

      // Cache the result
      if (process.env.REDIS_URL && article) {
        const { Redis } = await import('@upstash/redis');
        const redis = new Redis({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
        await setCache(redis, cacheKey, article, 3600); // Cache for 1 hour
      }
    }

    if (!article) {
      return new Response(JSON.stringify({ error: 'Article not found or could not be parsed' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const response = new Response(JSON.stringify({ article }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    await logRequest(request, response, startTime, null, sessionId);

    return response;

  } catch (error) {
    await logError(error, request, null, sessionId);
    return new Response(JSON.stringify({ error: 'Failed to fetch article' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function fetchAndParseArticle(url) {
  try {
    // Fetch the article
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Post-Machine/1.0 (Article Parser)'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();

    // Simple HTML parsing (in a real app, you'd use a proper HTML parser)
    const title = extractTitle(html);
    const description = extractDescription(html);
    const content = extractContent(html);
    const author = extractAuthor(html);
    const publishedAt = extractPublishedDate(html);

    return {
      url,
      title,
      description,
      content,
      author,
      publishedAt,
      fetchedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('Failed to fetch/parse article:', error);
    return null;
  }
}

function extractTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();

  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) return h1Match[1].trim();

  return 'Untitled Article';
}

function extractDescription(html) {
  const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (metaDesc) return metaDesc[1].trim();

  const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (ogDesc) return ogDesc[1].trim();

  return null;
}

function extractContent(html) {
  // Extract main content (simplified - real implementation would be more sophisticated)
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return cleanHtml(articleMatch[1]);

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return cleanHtml(mainMatch[1]);

  // Fallback: extract paragraphs
  const paragraphs = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
  if (paragraphs) {
    return paragraphs.map(p => cleanHtml(p)).join('\n\n');
  }

  return null;
}

function extractAuthor(html) {
  const authorMeta = html.match(/<meta[^>]*name=["']author["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (authorMeta) return authorMeta[1].trim();

  const ogAuthor = html.match(/<meta[^>]*property=["']article:author["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (ogAuthor) return ogAuthor[1].trim();

  return null;
}

function extractPublishedDate(html) {
  const publishedMeta = html.match(/<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["'][^>]*>/i);
  if (publishedMeta) return publishedMeta[1].trim();

  const timeElement = html.match(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/i);
  if (timeElement) return timeElement[1].trim();

  return null;
}

function cleanHtml(html) {
  // Remove HTML tags and decode entities (simplified)
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}