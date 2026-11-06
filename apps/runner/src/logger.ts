/**
 * Logs JSON estructurados con correlación corrida/shard/contenedor (RNF-OBS-01). Todo mensaje y objeto pasa por
 * `sanitizeText`/`sanitizeJson` de @katalyst/shared antes de escribirse (RNF-SEG-01: sin tokens ni contraseñas en
 * logs). Los secretos conocidos de la asignación se añaden con `addKnownSecret` (se enmascaran literalmente).
 */
import pino, { type DestinationStream, type Logger } from 'pino';
import { sanitizeJson, sanitizeText } from '@katalyst/shared';

export type { Logger } from 'pino';

const knownSecrets = new Set<string>();

/** Registra un valor secreto (contraseña, leaseToken) para enmascararlo literalmente en todos los logs. */
export function addKnownSecret(value: string | null | undefined): void {
  if (value && value.length >= 4) knownSecrets.add(value);
}

export function knownSecretsList(): string[] {
  return [...knownSecrets];
}

export function sanitizeLogText(s: string): string {
  return sanitizeText(s, { knownSecrets: knownSecretsList() }).value;
}

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  base?: Record<string, unknown>;
  destination?: DestinationStream;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  return pino(
    {
      name: opts.name,
      level: opts.level ?? 'info',
      base: { service: opts.name, ...(opts.base ?? {}) },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      redact: {
        paths: ['leaseToken', '*.leaseToken', 'token', '*.token', 'password', '*.password', 'authorization', '*.authorization'],
        censor: '[REDACTED]',
      },
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => sanitizeJson(obj, { knownSecrets: knownSecretsList() }).value as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const clean = args.map((a) => (typeof a === 'string' ? sanitizeLogText(a) : a)) as Parameters<typeof method>;
          method.apply(this, clean);
        },
      },
    },
    opts.destination ?? pino.destination({ fd: 1, sync: false }),
  );
}

/** Logger silencioso para pruebas. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
