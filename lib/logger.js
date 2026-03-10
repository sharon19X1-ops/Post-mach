// Post Machine - Logger for Vercel Edge Functions

import { logToDB } from './db.js';

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const LOG_LEVEL_LABELS = {
  [LOG_LEVELS.ERROR]: 'ERROR',
  [LOG_LEVELS.WARN]: 'WARN',
  [LOG_LEVELS.INFO]: 'INFO',
  [LOG_LEVELS.DEBUG]: 'DEBUG'
};

class Logger {
  constructor(source, minLevel = LOG_LEVELS.INFO) {
    this.source = source;
    this.minLevel = minLevel;
  }

  async log(level, message, meta = {}, userId = null, sessionId = null, requestId = null, durationMs = null, statusCode = null, errorStack = null) {
    if (level > this.minLevel) return;

    const levelLabel = LOG_LEVEL_LABELS[level];
    const timestamp = new Date().toISOString();

    // Console logging for development
    const consoleMethod = level === LOG_LEVELS.ERROR ? 'error' :
                         level === LOG_LEVELS.WARN ? 'warn' : 'log';
    console[consoleMethod](`[${timestamp}] ${levelLabel} [${this.source}] ${message}`, meta);

    // Database logging for production
    if (process.env.APP_ENV === 'production' || process.env.LOG_TO_DB === 'true') {
      try {
        await logToDB(level, levelLabel, this.source, message, meta, userId, sessionId, requestId, durationMs, statusCode, errorStack);
      } catch (dbError) {
        console.error('Failed to log to database:', dbError);
      }
    }
  }

  async error(message, meta = {}, userId = null, sessionId = null, requestId = null, durationMs = null, statusCode = null, error = null) {
    const errorStack = error?.stack;
    await this.log(LOG_LEVELS.ERROR, message, meta, userId, sessionId, requestId, durationMs, statusCode, errorStack);
  }

  async warn(message, meta = {}, userId = null, sessionId = null, requestId = null, durationMs = null, statusCode = null) {
    await this.log(LOG_LEVELS.WARN, message, meta, userId, sessionId, requestId, durationMs, statusCode);
  }

  async info(message, meta = {}, userId = null, sessionId = null, requestId = null, durationMs = null, statusCode = null) {
    await this.log(LOG_LEVELS.INFO, message, meta, userId, sessionId, requestId, durationMs, statusCode);
  }

  async debug(message, meta = {}, userId = null, sessionId = null, requestId = null, durationMs = null, statusCode = null) {
    await this.log(LOG_LEVELS.DEBUG, message, meta, userId, sessionId, requestId, durationMs, statusCode);
  }
}

// Create logger instances
export const authLogger = new Logger('auth');
export const apiLogger = new Logger('api');
export const dbLogger = new Logger('db');
export const shareLogger = new Logger('share');

// Request logging middleware
export async function logRequest(request, response, startTime, userId = null, sessionId = null) {
  const duration = Date.now() - startTime;
  const url = new URL(request.url);
  const method = request.method;
  const status = response.status || 200;

  await apiLogger.info(`${method} ${url.pathname}`, {
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    status,
    duration,
    userAgent: request.headers.get('user-agent'),
    ip: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip')
  }, userId, sessionId, request.headers.get('x-request-id'), duration, status);
}

// Error logging helper
export async function logError(error, request, userId = null, sessionId = null) {
  const url = new URL(request.url);
  await apiLogger.error(`Request error: ${error.message}`, {
    method: request.method,
    path: url.pathname,
    stack: error.stack
  }, userId, sessionId, request.headers.get('x-request-id'), null, 500, error.stack);
}