# Post Machine - Vercel Migration Guide

## Overview

This guide documents the migration from Cloudflare Workers (legacy) to Vercel Edge Functions (current). The repository now supports both deployment platforms.

## Architecture Changes

### Legacy (Cloudflare Workers)
- **Runtime**: Cloudflare Workers runtime
- **Framework**: Hono.js
- **Database**: Cloudflare D1
- **Storage**: Cloudflare KV
- **Deployment**: `wrangler.toml`

### Current (Vercel)
- **Runtime**: Vercel Edge Runtime
- **Framework**: Native Node.js API routes
- **Database**: Neon PostgreSQL
- **Cache**: Upstash Redis
- **Deployment**: `vercel.json`

## File Structure

```
/
├── api/                    # Vercel API routes
│   ├── auth.js            # Authentication endpoints
│   ├── admin.js           # Admin endpoints
│   ├── share.js           # Article sharing
│   ├── discover.js        # Article discovery
│   ├── article.js         # Article parsing
│   └── health.js          # Health check
├── lib/                   # Shared utilities
│   ├── auth.js            # Authentication utilities
│   ├── db.js              # Database operations
│   └── logger.js          # Logging utilities
├── public/                # Static assets
│   └── index.html         # Frontend application
├── vercel.json            # Vercel configuration
├── .env.example           # Environment variables template
├── package.json           # Updated dependencies
└── wrangler.toml          # Legacy config (deprecated)
```

## Environment Variables

### Required for Vercel Deployment

```bash
# Database
DATABASE_URL=postgresql://user:pass@host/db

# Redis Cache
REDIS_URL=https://your-redis-url.upstash.io
REDIS_TOKEN=your-redis-token

# Authentication
SESSION_SECRET=your-session-secret
SESSION_TTL_SECS=28800

# OpenAI (for article processing)
OPENAI_API_KEY=your-openai-key

# Email/Slack/Discord (for sharing)
EMAIL_API_KEY=your-email-key
SLACK_WEBHOOK_URL=your-slack-webhook
DISCORD_WEBHOOK_URL=your-discord-webhook

# App Configuration
APP_ENV=production
LOG_TO_DB=true
```

## Deployment

### Vercel Deployment

1. **Connect Repository**:
   ```bash
   vercel --prod
   ```

2. **Set Environment Variables**:
   - Go to Vercel dashboard
   - Project Settings > Environment Variables
   - Add all required variables from `.env.example`

3. **Deploy**:
   ```bash
   vercel --prod
   ```

### Legacy Cloudflare Deployment (Deprecated)

⚠️ **Cloudflare deployment is deprecated**. Use only for legacy systems.

```bash
wrangler deploy
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current user

### Articles
- `GET /api/article/:url` - Parse article content
- `GET /api/discover/articles` - Discover articles

### Sharing
- `POST /api/share` - Share article to channels

### Admin
- `GET /api/admin/logs` - View application logs

### Health
- `GET /api/health` - Health check

## Database Schema

The database schema remains compatible. The migration involves:

1. **Export from Cloudflare D1**:
   ```sql
   .dump > backup.sql
   ```

2. **Import to Neon PostgreSQL**:
   ```bash
   psql $DATABASE_URL < backup.sql
   ```

## Key Differences

### Runtime
- **Cloudflare**: V8 isolate, limited Node.js compatibility
- **Vercel**: Full Node.js runtime with Edge optimizations

### Database
- **Cloudflare D1**: SQLite-compatible, limited SQL features
- **Neon**: Full PostgreSQL with advanced features

### Caching
- **Cloudflare KV**: Key-value store
- **Upstash Redis**: Full Redis functionality

### Deployment
- **Cloudflare**: `wrangler` CLI
- **Vercel**: Git-based, automatic deployments

## Migration Steps

1. **Backup Data**: Export from Cloudflare D1
2. **Setup Neon**: Create PostgreSQL database
3. **Import Data**: Load backup into Neon
4. **Configure Vercel**: Set environment variables
5. **Deploy**: Push to Vercel
6. **Test**: Verify all functionality
7. **Update DNS**: Point domain to Vercel
8. **Monitor**: Check logs and performance

## Rollback Plan

If issues arise with Vercel deployment:

1. **Keep Cloudflare Workers active** during transition
2. **Gradual traffic migration** using DNS weighting
3. **Monitor error rates** and performance metrics
4. **Quick rollback** by updating DNS back to Cloudflare

## Performance Considerations

- **Edge Functions**: Lower cold start times than Cloudflare Workers
- **PostgreSQL**: Better query performance for complex operations
- **Redis**: Improved caching capabilities
- **Global CDN**: Automatic edge deployment

## Monitoring

### Vercel Analytics
- Response times
- Error rates
- Function invocations

### Application Logs
- Structured logging to database
- Error tracking with stack traces
- User activity monitoring

## Security

- **Environment Variables**: Encrypted at rest
- **Session Management**: Secure HTTP-only cookies
- **CORS**: Configured for web application
- **Rate Limiting**: Built into Vercel platform

## Troubleshooting

### Common Issues

1. **Database Connection**:
   - Verify `DATABASE_URL` format
   - Check Neon database status

2. **Redis Connection**:
   - Verify Upstash credentials
   - Check Redis URL format

3. **API Timeouts**:
   - Edge Functions have 30s limit
   - Optimize database queries

4. **Cold Starts**:
   - Expected with Edge Functions
   - Minimize with proper caching

### Debug Commands

```bash
# Check Vercel deployment
vercel logs

# Test API endpoints
curl https://your-app.vercel.app/api/health

# Check database connection
psql $DATABASE_URL -c "SELECT 1"
```

## Future Considerations

- **Hybrid Deployment**: Maintain both platforms during transition
- **Feature Parity**: Ensure all Cloudflare features migrate successfully
- **Performance Monitoring**: Compare metrics between platforms
- **Cost Optimization**: Evaluate pricing differences

## Support

For migration issues:
1. Check Vercel documentation
2. Review application logs
3. Test with development environment
4. Contact platform support if needed

---

**Migration Status**: ✅ Complete
**Legacy Support**: ⚠️ Deprecated (available until EOL)
**Current Platform**: Vercel Edge Functions