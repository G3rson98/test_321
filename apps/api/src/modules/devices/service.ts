/**
 * Flujo de dispositivo del asistente local (RFC 8628 adaptado; ESP §13.6, §9 bloque 2C):
 * 1. `POST /devices/authorize` (público, rate limit): `deviceCode` secreto (solo su hash en BD) + `userCode` de un
 *    solo uso `XXXX-XXXX`, vencimiento 5 min, intervalo de consulta 5 s.
 * 2. El usuario aprueba/deniega desde su SESIÓN del panel (`/devices/approve|deny`, requiere cookie de sesión).
 * 3. `POST /devices/token` (público, rate limit, consulta limitada por código): pendiente → `DEVICE_AUTHORIZATION_PENDING`;
 *    consulta antes del intervalo → `DEVICE_SLOW_DOWN` (+5 s); vencido → `DEVICE_CODE_EXPIRED`; denegado →
 *    `DEVICE_ACCESS_DENIED`; aprobado → emite UNA vez la credencial de dispositivo revocable (`kdv_…`, solo hash en BD,
 *    `api_credential` kind `dispositivo` 1:1 con `device`) y consume el código.
 * La credencial autentica al asistente (no es sesión del sistema bajo prueba). RF-GRB-01, RNF-SEG-01.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  KatalystError,
} from '@katalyst/shared';
import { recordAudit } from '../../lib/audit.js';
import type { Principal } from '../../lib/auth.js';
import { generateOpaqueToken, hashToken, randomUserCode, tokenHint, tokenKindOf } from '../../lib/crypto-tokens.js';
import { apiCSettings } from '../recordings/settings.js';

type Db = PrismaClient | Prisma.TransactionClient;

export function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export async function startDeviceAuthorization(
  prisma: PrismaClient,
  publicBaseUrl: string,
  input: { clientName: string; clientVersion: string; platform: 'windows' | 'macos' | 'linux' },
  now = new Date(),
) {
  const deviceCode = generateOpaqueToken('deviceCode');
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);
  let userCode = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    userCode = formatUserCode(randomUserCode(8));
    try {
      await prisma.deviceAuthorization.create({
        data: {
          deviceCodeHash: hashToken(deviceCode),
          userCode,
          clientName: input.clientName,
          clientVersion: input.clientVersion,
          platform: input.platform,
          intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
          expiresAt,
        },
      });
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002' || attempt === 4) throw err;
    }
  }
  const verificationUri = `${publicBaseUrl.replace(/\/+$/, '')}${apiCSettings().DEVICE_VERIFICATION_PATH}`;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?codigo=${encodeURIComponent(userCode)}`,
    expiresIn: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  };
}

/** `POST /devices/token`: consulta del asistente. */
export async function pollDeviceToken(prisma: PrismaClient, deviceCode: string, now = new Date()) {
  if (tokenKindOf(deviceCode) !== 'deviceCode') throw new KatalystError('DEVICE_CODE_INVALID');
  const auth = await prisma.deviceAuthorization.findUnique({ where: { deviceCodeHash: hashToken(deviceCode) } });
  if (!auth || auth.status === 'consumida') throw new KatalystError('DEVICE_CODE_INVALID');
  if (auth.status === 'denegada') throw new KatalystError('DEVICE_ACCESS_DENIED');
  if (auth.status === 'vencida' || auth.expiresAt <= now) {
    if (auth.status !== 'vencida') {
      await prisma.deviceAuthorization.updateMany({ where: { id: auth.id, status: { in: ['pendiente', 'aprobada'] } }, data: { status: 'vencida' } });
    }
    throw new KatalystError('DEVICE_CODE_EXPIRED');
  }
  // Consulta limitada por código (además del rate limit por IP de la ruta).
  if (auth.lastPolledAt && now.getTime() - auth.lastPolledAt.getTime() < auth.intervalSeconds * 1000) {
    await prisma.deviceAuthorization.update({
      where: { id: auth.id },
      data: { lastPolledAt: now, intervalSeconds: Math.min(auth.intervalSeconds + 5, 60) },
    });
    throw new KatalystError('DEVICE_SLOW_DOWN', undefined, { retryAfterSeconds: Math.min(auth.intervalSeconds + 5, 60) });
  }
  if (auth.status === 'pendiente') {
    await prisma.deviceAuthorization.update({ where: { id: auth.id }, data: { lastPolledAt: now } });
    throw new KatalystError('DEVICE_AUTHORIZATION_PENDING');
  }
  // aprobada → emitir una sola vez (transición condicional aprobada → consumida).
  const s = apiCSettings();
  return prisma.$transaction(async (tx) => {
    const consumed = await tx.deviceAuthorization.updateMany({
      where: { id: auth.id, status: 'aprobada' },
      data: { status: 'consumida', lastPolledAt: now },
    });
    if (consumed.count !== 1 || !auth.userId) throw new KatalystError('DEVICE_CODE_INVALID');
    const user = await tx.panelUser.findUnique({ where: { id: auth.userId }, select: { id: true, disabledAt: true } });
    if (!user || user.disabledAt) throw new KatalystError('DEVICE_ACCESS_DENIED');
    const token = generateOpaqueToken('device');
    const expiresAt = new Date(now.getTime() + s.DEVICE_CREDENTIAL_TTL_DAYS * 86_400_000);
    const cred = await tx.apiCredential.create({
      data: {
        principalId: user.id,
        kind: 'dispositivo',
        name: `Asistente ${auth.clientName}`.slice(0, 100),
        tokenHash: hashToken(token),
        scopes: ['recordings.create', 'recordings.read'],
        hint: tokenHint(token),
        expiresAt,
        createdById: user.id,
      },
    });
    const device = await tx.device.create({
      data: {
        userId: user.id,
        credentialId: cred.id,
        name: auth.clientName,
        platform: auth.platform,
        clientVersion: auth.clientVersion,
        expiresAt,
        lastSeenAt: now,
      },
    });
    await tx.deviceAuthorization.update({ where: { id: auth.id }, data: { deviceId: device.id } });
    return { accessToken: token, tokenType: 'Bearer' as const, deviceId: device.id, expiresAt: expiresAt.toISOString() };
  });
}

async function pendingByUserCode(db: Db, userCode: string, now: Date) {
  const auth = await db.deviceAuthorization.findUnique({ where: { userCode } });
  if (!auth) throw new KatalystError('NOT_FOUND');
  if (auth.status === 'pendiente' && auth.expiresAt <= now) {
    await db.deviceAuthorization.update({ where: { id: auth.id }, data: { status: 'vencida' } });
    return { ...auth, status: 'vencida' as const };
  }
  return auth;
}

export async function viewAuthorization(prisma: PrismaClient, userCode: string, now = new Date()) {
  const auth = await pendingByUserCode(prisma, userCode, now);
  return {
    userCode: auth.userCode,
    clientName: auth.clientName,
    clientVersion: auth.clientVersion,
    platform: auth.platform,
    status: auth.status,
    expiresAt: auth.expiresAt.toISOString(),
  };
}

/** Aprobación/denegación desde la sesión del panel (el llamador garantiza `principal.kind === 'panel_user'`). */
export async function decideAuthorization(
  prisma: PrismaClient,
  actor: Extract<Principal, { kind: 'panel_user' }>,
  userCode: string,
  decision: 'aprobada' | 'denegada',
  requestId?: string,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const auth = await pendingByUserCode(tx, userCode, now);
    if (auth.status === 'vencida') throw new KatalystError('DEVICE_CODE_EXPIRED');
    if (auth.status !== 'pendiente') {
      // Idempotente para la misma decisión del mismo usuario.
      if (auth.status === decision && auth.userId === actor.id) return { ok: true as const };
      throw new KatalystError('CONFLICT', 'La solicitud ya fue resuelta.');
    }
    const r = await tx.deviceAuthorization.updateMany({
      where: { id: auth.id, status: 'pendiente' },
      data: { status: decision, userId: actor.id, ...(decision === 'aprobada' ? { approvedAt: now } : {}) },
    });
    if (r.count !== 1) throw new KatalystError('CONFLICT', 'La solicitud ya fue resuelta.');
    await recordAudit(tx, {
      actor,
      action: 'device.approve',
      entity: 'device_authorization',
      entityId: auth.id,
      diff: { decision, clientName: auth.clientName, platform: auth.platform },
      ...(requestId ? { requestId } : {}),
    });
    return { ok: true as const };
  });
}

export function toDeviceDto(d: {
  id: string;
  name: string;
  platform: string;
  clientVersion: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    clientVersion: d.clientVersion,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
    expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
    revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
  };
}

export async function listDevices(db: Db, userId: string) {
  const rows = await db.device.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
  return rows.map(toDeviceDto);
}

export async function revokeDevice(
  prisma: PrismaClient,
  actor: Principal,
  deviceId: string,
  ownerCheck: (userId: string) => boolean,
  requestId?: string,
) {
  await prisma.$transaction(async (tx) => {
    const d = await tx.device.findUnique({ where: { id: deviceId } });
    if (!d || !ownerCheck(d.userId)) throw new KatalystError('NOT_FOUND');
    if (d.revokedAt) return;
    const now = new Date();
    await tx.device.update({ where: { id: d.id }, data: { revokedAt: now } });
    await tx.apiCredential.update({ where: { id: d.credentialId }, data: { revokedAt: now } });
    await recordAudit(tx, {
      actor,
      action: 'device.revoke',
      entity: 'device',
      entityId: d.id,
      ...(requestId ? { requestId } : {}),
    });
  });
}

/** Estado del asistente vinculado del usuario (ESP §9: "estado de salud del asistente vinculado"). */
export async function deviceStatus(db: Db, userId: string, now = new Date()) {
  const s = apiCSettings();
  const d = await db.device.findFirst({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  });
  return {
    linked: !!d,
    online: !!d?.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() <= s.DEVICE_ONLINE_WINDOW_SECONDS * 1000,
    lastSeenAt: d?.lastSeenAt ? d.lastSeenAt.toISOString() : null,
    clientVersion: d?.clientVersion ?? null,
    installUrl: s.RECORDER_INSTALL_URL ?? null,
  };
}

export async function deviceHeartbeat(
  prisma: PrismaClient,
  deviceId: string,
  input: { clientVersion: string; activeRecordingId: string | null },
  now = new Date(),
) {
  const r = await prisma.device.updateMany({
    where: { id: deviceId, revokedAt: null },
    data: { lastSeenAt: now, clientVersion: input.clientVersion },
  });
  if (r.count !== 1) throw new KatalystError('TOKEN_REVOKED');
  return { ok: true as const };
}
