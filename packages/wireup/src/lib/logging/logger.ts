/**
 * Server-side structured logger.
 *
 * Deliberately tiny and dependency free. Output is line-oriented JSON in
 * production and readable text in development. Credentials are redacted.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = [
  'aws_access_key_id',
  'aws_secret_access_key',
  'aws_session_token',
  'accesskeyid',
  'secretaccesskey',
  'sessiontoken',
  'password',
  'token',
  'authorization',
  'mongodb_uri',
  'connectionstring',
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalised = key.toLowerCase().replace(/[^a-z]/g, '');
      out[key] = REDACT_KEYS.includes(normalised) ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

function minLevel(): number {
  const configured = (process.env.WIREUP_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return LEVEL_ORDER[configured as LogLevel] ?? LEVEL_ORDER.info;
}

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Log arguments accept both conventions used across the codebase:
 * `logger.info('message', { meta })` and `logger.info({ meta }, 'message')`.
 */
export type LogFirst = string | Record<string, unknown>;
export type LogSecond = string | Record<string, unknown> | undefined;

function normalise(first: LogFirst, second?: LogSecond): { message: string; meta?: Record<string, unknown> } {
  if (typeof first === 'string') {
    return {
      message: first,
      meta: typeof second === 'object' && second !== null ? (second as Record<string, unknown>) : undefined,
    };
  }
  return {
    message: typeof second === 'string' ? second : '',
    meta: first,
  };
}

export interface Logger {
  debug(first: LogFirst, second?: LogSecond): void;
  info(first: LogFirst, second?: LogSecond): void;
  warn(first: LogFirst, second?: LogSecond): void;
  error(first: LogFirst, second?: LogSecond): void;
  child(scope: string): Logger;
}

function write(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const payload = {
    level,
    scope,
    message,
    time: new Date().toISOString(),
    ...(meta ? { meta: redact(meta) as Record<string, unknown> } : {}),
  };

  if (isProduction()) {
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    return;
  }

  const prefix = `[wireup:${scope}]`;
  if (level === 'error') console.error(prefix, message, meta ? redact(meta) : '');
  else if (level === 'warn') console.warn(prefix, message, meta ? redact(meta) : '');
  else if (level === 'debug') console.debug(prefix, message, meta ? redact(meta) : '');
  else console.log(prefix, message, meta ? redact(meta) : '');
}

function makeLogger(scope: string): Logger {
  const emit = (level: LogLevel) => (first: LogFirst, second?: LogSecond): void => {
    const { message, meta } = normalise(first, second);
    write(level, scope, message, meta);
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (childScope) => makeLogger(`${scope}:${childScope}`),
  };
}

export function createLogger(scope = 'app'): Logger {
  return makeLogger(scope);
}

export const logger = createLogger();

/** Normalise unknown throwables into a message + optional stack. */
export function describeError(error: unknown): { message: string; stack?: string; name?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}
