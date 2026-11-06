/**
 * Slack y Microsoft Teams por webhook entrante (ESP §12: canal pendiente; configurable por admin, URL por referencia
 * de secreto). La URL del webhook es un secreto: nunca se registra ni se refleja en mensajes de error.
 * - SSRF: la URL se valida contra una allowlist de hosts del proveedor (ESP §13.7) antes de cada envío.
 * - Clasificación: 2xx → entregada; 429/5xx → reintentable (respeta Retry-After); otros 4xx → permanente;
 *   corte/timeout después de enviar → ambigua (webhooks sin confirmación idempotente, ESP §13.8).
 * RF-NOT-01, RF-NOT-02.
 */
import { assertUrlAllowed, resolveAndCheck, type SsrfPolicy } from '../../lib/ssrf.js';
import type { NotificationMessage, NotificationTarget, Notifier, SendResult } from './types.js';

export const SLACK_WEBHOOK_HOSTS = ['hooks.slack.com'] as const;
export const TEAMS_WEBHOOK_HOSTS = ['*.webhook.office.com', '*.logic.azure.com', '*.powerplatform.com'] as const;
const DEFAULT_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface WebhookNotifierOptions {
  policy?: SsrfPolicy;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Resolver DNS (pruebas). */
  skipDnsCheck?: boolean;
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 3_600_000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, Math.min(d - Date.now(), 3_600_000)) : undefined;
}

/** Errores de conexión ANTES de enviar el cuerpo: es seguro reintentar. */
function isPreSendNetworkError(err: unknown): boolean {
  const code =
    (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string } | undefined)?.code ?? '';
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED'].includes(code);
}

export async function postWebhook(
  rawUrl: string,
  body: unknown,
  opts: WebhookNotifierOptions & { defaultHosts: readonly string[] },
): Promise<SendResult> {
  const policy: SsrfPolicy = opts.policy ?? { allowedHosts: opts.defaultHosts, allowedSchemes: ['https'] };
  let url: URL;
  try {
    url = assertUrlAllowed(rawUrl, policy);
    if (!opts.skipDnsCheck) await resolveAndCheck(url.hostname, policy);
  } catch {
    return { outcome: 'permanente', message: 'URL del webhook no permitida por la política de destinos' };
  }
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  try {
    const res = await doFetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    // No se lee/refleja el cuerpo de respuesta más allá de descartarlo.
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) {
      return { outcome: 'entregada', message: 'Entregada', httpStatus: res.status };
    }
    if (res.status === 429 || res.status >= 500 || res.status === 408) {
      const ra = retryAfterMs(res);
      return {
        outcome: 'reintentable',
        message: `El webhook respondió ${res.status}`,
        httpStatus: res.status,
        ...(ra !== undefined ? { retryAfterMs: ra } : {}),
      };
    }
    return { outcome: 'permanente', message: `El webhook rechazó el mensaje (${res.status})`, httpStatus: res.status };
  } catch (err) {
    if (isPreSendNetworkError(err)) {
      return { outcome: 'reintentable', message: 'No se pudo conectar con el webhook' };
    }
    // Timeout o corte tras enviar: no se sabe si el canal lo recibió.
    return { outcome: 'ambigua', message: 'Entrega ambigua: el webhook no confirmó a tiempo' };
  }
}

function severityEmoji(sev: NotificationMessage['severity']): string {
  return sev === 'error' ? ':red_circle:' : sev === 'warning' ? ':warning:' : ':information_source:';
}

export function slackPayload(m: NotificationMessage): unknown {
  const facts = m.facts.map((f) => `*${f.name}:* ${f.value}`).join('\n');
  const text = `${severityEmoji(m.severity)} *${m.subject}*\n${m.text}${facts ? `\n${facts}` : ''}${
    m.link ? `\n<${m.link}|Ver en Katalyst (requiere sesión)>` : ''
  }`;
  return { text, unfurl_links: false, unfurl_media: false };
}

export function teamsPayload(m: NotificationMessage): unknown {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: m.subject,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
              color: m.severity === 'error' ? 'Attention' : m.severity === 'warning' ? 'Warning' : 'Default',
            },
            { type: 'TextBlock', text: m.text, wrap: true },
            { type: 'FactSet', facts: m.facts.map((f) => ({ title: f.name, value: f.value })) },
          ],
          actions: m.link ? [{ type: 'Action.OpenUrl', title: 'Ver en Katalyst', url: m.link }] : [],
        },
      },
    ],
  };
}

export class SlackNotifier implements Notifier {
  readonly kind = 'slack' as const;
  constructor(private readonly opts: WebhookNotifierOptions = {}) {}
  async send(message: NotificationMessage, target: NotificationTarget): Promise<SendResult> {
    if (!target.secret) return { outcome: 'permanente', message: 'Webhook de Slack no configurado' };
    return postWebhook(target.secret.trim(), slackPayload(message), { ...this.opts, defaultHosts: SLACK_WEBHOOK_HOSTS });
  }
}

export class TeamsNotifier implements Notifier {
  readonly kind = 'teams' as const;
  constructor(private readonly opts: WebhookNotifierOptions = {}) {}
  async send(message: NotificationMessage, target: NotificationTarget): Promise<SendResult> {
    if (!target.secret) return { outcome: 'permanente', message: 'Webhook de Teams no configurado' };
    return postWebhook(target.secret.trim(), teamsPayload(message), { ...this.opts, defaultHosts: TEAMS_WEBHOOK_HOSTS });
  }
}
