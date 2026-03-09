/**
 * Post Machine — POST /api/discover
 * Requires: authenticated session
 */
import { z }                        from 'zod';
import { createLogger, LOG_SOURCE } from './logger.js';

const Schema = z.object({
  topic: z.string().min(2).max(200).trim(),
});

export async function handleDiscover(ctx) {
  const user = ctx.get('user');
  const log  = ctx.get('log').child({ source: LOG_SOURCE.DISCOVER, userId: user.id });

  const parsed = Schema.safeParse(await ctx.req.json().catch(() => ({})));
  if (!parsed.success) {
    log.warn('Invalid discover request', { errors: parsed.error.flatten() });
    return ctx.json({ error: 'topic is required (2–200 chars)' }, 400);
  }

  const { topic } = parsed.data;
  const cacheKey  = `discover:${await hashKey(topic)}`;

  // ── Cache hit ──────────────────────────────────────────────────
  const cached = await ctx.env.CACHE.get(cacheKey, 'json').catch(() => null);
  if (cached) {
    log.cache('hit', cacheKey, { topic });
    log.info('Returning cached discovery', { topic, count: cached.length });
    return ctx.json(cached);
  }

  log.cache('miss', cacheKey, { topic });
  log.info('Discovery started', { topic, userId: user.id });

  let results;
  try {
    results = await log.time('AI discovery pipeline', async () => {
      const queries  = await expandTopic(ctx.env, topic, log);
      const rawItems = await searchBrave(ctx.env, queries, log);
      return generateReviews(ctx.env, rawItems, log);
    }, { topic });
  } catch (err) {
    log.error('Discovery pipeline failed', err, { topic });
    return ctx.json({ error: 'Discovery failed, please try again' }, 503);
  }

  if (!results || results.length === 0) {
    log.warn('No results found', { topic });
    return ctx.json({
      error:       'No results found for this topic',
      code:        'NO_RESULTS',
      suggestions: ['Try broader keywords', 'Check spelling', 'Try a related topic'],
    }, 404);
  }

  const ttl = Number(ctx.env.CACHE_TTL_SECS ?? 1800);
  await ctx.env.CACHE.put(cacheKey, JSON.stringify(results), { expirationTtl: ttl }).catch(() => {});
  log.info('Discovery complete', { topic, count: results.length });
  return ctx.json(results);
}

// ── Helpers ───────────────────────────────────────────────────────
async function hashKey(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str.toLowerCase().trim()));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).slice(0,16);
}

async function expandTopic(env, topic, log) {
  try {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt: `Generate 4 web search queries for the following topic: ${JSON.stringify(topic)}. Return ONLY a JSON array of strings, no preamble.`,
      max_tokens: 200,
    });
    const q = JSON.parse(r.response);
    log.debug('Topic expanded', { topic, queries: q });
    return Array.isArray(q) ? q.slice(0,4) : [topic];
  } catch {
    log.warn('Topic expansion failed — using raw topic', { topic });
    return [topic];
  }
}

async function searchBrave(env, queries, log) {
  const apiKey = env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY not configured');

  const results = await Promise.allSettled(
    queries.map(q =>
      fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`, {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
      }).then(r => r.json())
    )
  );

  const seen = new Set();
  const items = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const w of (r.value?.web?.results ?? [])) {
      if (!seen.has(w.url)) {
        seen.add(w.url);
        items.push({ title: w.title, url: w.url, description: w.description, domain: new URL(w.url).hostname });
      }
    }
  }

  log.debug('Brave search complete', { queryCount: queries.length, rawResults: items.length });
  if (items.length === 0) throw new Error('NO_RESULTS');
  return items;
}

async function generateReviews(env, items, log) {
  const top = items.slice(0, 6);
  return Promise.all(top.map(async item => {
    try {
      const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        prompt: `Write a 2-sentence review and a quality score (0.0-1.0) for this article.
Title: "${item.title}"
Description: "${item.description ?? ''}"
Return ONLY JSON: {"review":"...","score":0.8}`,
        max_tokens: 150,
      });
      const parsed = JSON.parse(r.response);
      return {
        id:          await hashKey(item.url),
        title:       item.title,
        url:         item.url,
        domain:      item.domain,
        teaser:      parsed.review ?? item.description,
        score:       Math.min(1, Math.max(0, Number(parsed.score ?? 0.7))),
        readingTime: Math.max(1, Math.round((item.description?.length ?? 500) / 200)),
      };
    } catch {
      return {
        id: await hashKey(item.url), title: item.title,
        url: item.url, domain: item.domain,
        teaser: item.description ?? 'No preview available.',
        score: 0.6, readingTime: 3,
      };
    }
  }));
}
