/**
 * Post Machine — POST /api/article
 */
import { z }                        from 'zod';
import { createLogger, LOG_SOURCE } from '../lib/logger.js';

const Schema = z.object({ url: z.string().url().max(2048) });

export async function handleArticle(ctx) {
  const user = ctx.get('user');
  const log  = ctx.get('log').child({ source: LOG_SOURCE.ARTICLE, userId: user.id });

  const parsed = Schema.safeParse(await ctx.req.json().catch(() => ({})));
  if (!parsed.success) return ctx.json({ error: 'Valid url is required' }, 400);

  const { url } = parsed.data;
  const cacheKey = `article:${url.slice(0, 200)}`;

  const cached = await ctx.env.CACHE.get(cacheKey, 'json').catch(() => null);
  if (cached) { log.cache('hit', cacheKey); return ctx.json(cached); }

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { 'User-Agent': 'PostMachine/1.0 (+https://postmachine.app)' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    log.error('Article fetch failed', err, { url });
    return ctx.json({ error: 'Could not fetch article', code: 'FETCH_FAILED' }, 502);
  }

  if (upstream.status === 404 || upstream.status === 410) {
    return ctx.json({ error: 'Article no longer available', code: 'ARTICLE_NOT_FOUND' }, 404);
  }
  if (!upstream.ok) {
    return ctx.json({ error: 'Article source returned an error', code: 'UPSTREAM_ERROR' }, 502);
  }

  const html = await upstream.text();
  if (!html || html.trim().length < 100) {
    log.warn('Empty article body', { url });
    return ctx.json({ error: 'Could not extract article content', code: 'EMPTY_CONTENT', originalUrl: url }, 422);
  }

  // Lightweight extraction (title + body from meta/og tags)
  const title   = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? 'Untitled';
  const ogDesc  = html.match(/property="og:description"[^>]*content="([^"]+)"/i)?.[1] ?? '';
  const author  = html.match(/name="author"[^>]*content="([^"]+)"/i)?.[1] ?? null;
  // Strip tags, collapse whitespace, first 3000 chars
  const body    = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,3000);

  if (!body || body.length < 50) {
    return ctx.json({ error: 'Could not extract article content', code: 'EMPTY_CONTENT', originalUrl: url }, 422);
  }

  const article = {
    title, url, body, author, domain: new URL(url).hostname,
    description: ogDesc,
    fetchedAt: Date.now(),
  };

  const ttl = Number(ctx.env.ARTICLE_TTL_SECS ?? 3600);
  await ctx.env.CACHE.put(cacheKey, JSON.stringify(article), { expirationTtl: ttl }).catch(() => {});
  log.info('Article fetched', { url, titleLen: title.length });
  return ctx.json(article);
}
