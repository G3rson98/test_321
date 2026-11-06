/**
 * Sesiones del panel en `panel_session` (RF-USR-01, ESP §13.7): token opaco en cookie HttpOnly; en BD solo
 * SHA-256 del token y del token CSRF derivado. Revocación en logout, cambio/recuperación de contraseña y
 * deshabilitación del usuario.
 */
import type { FastifyReply } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { csrfTokenFor, sessionCookieName } from '../../lib/auth.js';
import { generateOpaqueToken, hashToken } from '../../lib/crypto-tokens.js';
import type { Config } from '../../config.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface CreatedSession {
  id: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db,
  userId: string,
  ttlHours: number,
  meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
  now: Date = new Date(),
): Promise<CreatedSession> {
  const token = generateOpaqueToken('session');
  const csrfToken = csrfTokenFor(token);
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000);
  const row = await db.panelSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      expiresAt,
      lastSeenAt: now,
      ipHash: meta.ip ? hashToken(`ip:${meta.ip}`) : null,
      userAgentHash: meta.userAgent ? hashToken(`ua:${meta.userAgent}`) : null,
    },
    select: { id: true },
  });
  return { id: row.id, token, csrfToken, expiresAt };
}

export async function revokeSession(db: Db, sessionId: string, now: Date = new Date()): Promise<void> {
  await db.panelSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}

/** Revoca todas las sesiones del usuario (opcionalmente salvo una). */
export async function revokeUserSessions(
  db: Db,
  userId: string,
  exceptSessionId?: string,
  now: Date = new Date(),
): Promise<number> {
  const r = await db.panelSession.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: now },
  });
  return r.count;
}

export function setSessionCookie(reply: FastifyReply, config: Config, s: { token: string; expiresAt: Date }): void {
  void reply.setCookie(sessionCookieName(config), s.token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
    expires: s.expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  void reply.clearCookie(sessionCookieName(config), {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
  });
}
