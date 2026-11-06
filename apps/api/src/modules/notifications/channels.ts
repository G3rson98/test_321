/**
 * Canales de notificación del equipo (RF-NOT-01; canal pendiente ESP §12, configurable por admin). Una fila por tipo
 * (`correo | slack | teams`); sin fila se usa el bootstrap de entorno (`NOTIFIER_CHANNELS`, `*_REF`, `SMTP_*`).
 * Webhooks y credenciales SMTP SOLO por referencia de secreto; nunca se devuelven ni registran sus valores.
 */
import { Prisma, type NotificationChannel, type PrismaClient } from '@prisma/client';
import {
  KatalystError,
  NOTIFICATION_CHANNEL_KINDS,
  sanitizeText,
  type NotificationChannelKind,
} from '@katalyst/shared';
import type { Config } from '../../config.js';
import { getNotifiers, type NotificationMessage, type NotificationTarget, type NotifierRegistry } from '../../adapters/notifier/index.js';
import { recordAudit } from '../../lib/audit.js';
import type { Principal } from '../../lib/auth.js';
import { getSecretProvider, type SecretProvider } from '../../lib/secrets.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface EffectiveChannel {
  kind: NotificationChannelKind;
  enabled: boolean;
  secretRef: string | null;
  recipients: string[];
  smtp: { host: string; port: number; from: string; secure: boolean } | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  updatedAt: Date;
  version: number;
  /** `false` si proviene del bootstrap de entorno (sin fila en BD). */
  persisted: boolean;
}

function bootstrap(kind: NotificationChannelKind, config: Config): EffectiveChannel {
  const enabled = config.NOTIFIER_CHANNELS.includes(kind);
  const secretRef =
    kind === 'slack' ? (config.SLACK_WEBHOOK_REF ?? null) : kind === 'teams' ? (config.TEAMS_WEBHOOK_REF ?? null) : (config.SMTP_CREDENTIALS_REF ?? null);
  const smtp =
    kind === 'correo' && config.SMTP_HOST && config.SMTP_FROM
      ? { host: config.SMTP_HOST, port: config.SMTP_PORT, from: config.SMTP_FROM, secure: true }
      : null;
  return {
    kind,
    enabled,
    secretRef,
    recipients: [],
    smtp,
    lastTestAt: null,
    lastTestOk: null,
    updatedAt: new Date(0),
    version: 0,
    persisted: false,
  };
}

function fromRow(r: NotificationChannel): EffectiveChannel {
  return {
    kind: r.kind,
    enabled: r.enabled,
    secretRef: r.secretRef,
    recipients: r.recipients,
    smtp: (r.smtp as EffectiveChannel['smtp']) ?? null,
    lastTestAt: r.lastTestAt,
    lastTestOk: r.lastTestOk,
    updatedAt: r.updatedAt,
    version: r.version,
    persisted: true,
  };
}

export async function listChannels(db: Db, config: Config): Promise<EffectiveChannel[]> {
  const rows = await db.notificationChannel.findMany();
  return NOTIFICATION_CHANNEL_KINDS.map((k) => {
    const row = rows.find((r) => r.kind === k);
    return row ? fromRow(row) : bootstrap(k, config);
  });
}

/** ¿Está completo para enviar? (correo: SMTP; webhooks: referencia). */
export function isConfigured(c: EffectiveChannel): boolean {
  return c.kind === 'correo' ? c.smtp !== null : c.secretRef !== null;
}

/** Canales habilitados y configurados (opcionalmente restringidos a `only`). */
export async function activeChannels(
  db: Db,
  config: Config,
  only?: readonly NotificationChannelKind[],
): Promise<EffectiveChannel[]> {
  return (await listChannels(db, config)).filter(
    (c) => c.enabled && isConfigured(c) && (!only || only.length === 0 || only.includes(c.kind)),
  );
}

export function toChannelDto(c: EffectiveChannel) {
  return {
    kind: c.kind,
    enabled: c.enabled,
    secretRef: c.secretRef,
    recipients: c.recipients,
    smtp: c.smtp,
    lastTestAt: c.lastTestAt ? c.lastTestAt.toISOString() : null,
    lastTestOk: c.lastTestOk,
    updatedAt: c.updatedAt.toISOString(),
    version: c.version,
  };
}

export interface ChannelUpdateInput {
  enabled: boolean;
  secretRef?: string | null | undefined;
  recipients?: string[] | undefined;
  smtp?: { host: string; port: number; from: string; secure: boolean } | null | undefined;
  version?: number | undefined;
}

export async function updateChannel(
  prisma: PrismaClient,
  config: Config,
  actor: Principal,
  kind: NotificationChannelKind,
  input: ChannelUpdateInput,
  requestId?: string,
): Promise<EffectiveChannel> {
  return prisma.$transaction(async (tx) => {
    const current = (await listChannels(tx, config)).find((c) => c.kind === kind)!;
    if (input.version !== undefined && current.persisted && input.version !== current.version) {
      throw new KatalystError('VERSION_CONFLICT');
    }
    const next = {
      enabled: input.enabled,
      secretRef: input.secretRef === undefined ? current.secretRef : input.secretRef,
      recipients: input.recipients ?? current.recipients,
      smtp: input.smtp === undefined ? current.smtp : input.smtp,
    };
    if (kind !== 'correo' && next.smtp) throw new KatalystError('VALIDATION_FAILED', 'SMTP solo aplica al correo.');
    if (next.enabled && !isConfigured({ ...current, ...next })) throw new KatalystError('CHANNEL_NOT_CONFIGURED');
    const data = {
      enabled: next.enabled,
      secretRef: next.secretRef,
      recipients: next.recipients.map((r) => r.toLowerCase()),
      smtp: next.smtp ? (next.smtp as Prisma.InputJsonValue) : Prisma.DbNull,
    };
    let row: NotificationChannel;
    if (current.persisted) {
      const r = await tx.notificationChannel.updateMany({
        where: { kind, version: current.version },
        data: { ...data, version: { increment: 1 } },
      });
      if (r.count !== 1) throw new KatalystError('VERSION_CONFLICT');
      row = await tx.notificationChannel.findUniqueOrThrow({ where: { kind } });
    } else {
      row = await tx.notificationChannel.create({ data: { kind, ...data } });
    }
    await recordAudit(tx, {
      actor,
      action: 'notification_channel.update',
      entity: 'notification_channel',
      entityId: row.id,
      diff: { kind, enabled: next.enabled, secretRef: next.secretRef, recipients: next.recipients.length, smtp: next.smtp },
      ...(requestId ? { requestId } : {}),
    });
    return fromRow(row);
  });
}

/** Resuelve el destino con el secreto (solo en memoria durante el envío). */
export async function resolveTarget(
  c: EffectiveChannel,
  extraRecipients: readonly string[] = [],
  secrets: SecretProvider = getSecretProvider(),
): Promise<NotificationTarget> {
  const secret = c.secretRef ? await secrets.get(c.secretRef) : null;
  const recipients = [...new Set([...c.recipients, ...extraRecipients].map((r) => r.toLowerCase()))];
  return { kind: c.kind, secret, recipients, smtp: c.smtp };
}

/** `POST /notifications/channels/:kind/test`: envío de prueba sin datos sensibles. */
export async function testChannel(
  prisma: PrismaClient,
  config: Config,
  actor: Principal,
  kind: NotificationChannelKind,
  opts: { notifiers?: NotifierRegistry; secrets?: SecretProvider; requestId?: string } = {},
): Promise<{ ok: boolean; ambiguous: boolean; message: string }> {
  const channel = (await listChannels(prisma, config)).find((c) => c.kind === kind)!;
  if (!isConfigured(channel)) throw new KatalystError('CHANNEL_NOT_CONFIGURED');
  const message: NotificationMessage = {
    subject: '[Katalyst] Prueba de notificación',
    text: 'Mensaje de prueba del canal configurado en Katalyst. No requiere acción.',
    link: `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/configuracion/notificaciones`,
    facts: [{ name: 'Canal', value: kind }],
    severity: 'info',
  };
  let result: { ok: boolean; ambiguous: boolean; message: string };
  try {
    const target = await resolveTarget(channel, [], opts.secrets);
    const r = await (opts.notifiers ?? getNotifiers())[kind].send(message, target);
    result = { ok: r.outcome === 'entregada', ambiguous: r.outcome === 'ambigua', message: sanitizeText(r.message).value };
  } catch {
    result = { ok: false, ambiguous: false, message: 'No se pudo resolver la referencia del secreto del canal' };
  }
  await prisma.$transaction(async (tx) => {
    if (channel.persisted) {
      await tx.notificationChannel.update({ where: { kind }, data: { lastTestAt: new Date(), lastTestOk: result.ok } });
    } else {
      await tx.notificationChannel.create({
        data: {
          kind,
          enabled: channel.enabled,
          secretRef: channel.secretRef,
          recipients: channel.recipients,
          smtp: (channel.smtp ?? undefined) as Prisma.InputJsonValue | undefined,
          lastTestAt: new Date(),
          lastTestOk: result.ok,
        },
      });
    }
    await recordAudit(tx, {
      actor,
      action: 'notification_channel.update',
      entity: 'notification_channel',
      diff: { kind, test: true, ok: result.ok, ambiguous: result.ambiguous },
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    });
  });
  return result;
}
