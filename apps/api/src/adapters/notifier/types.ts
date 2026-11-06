/**
 * Interfaz `Notifier` (plan §4.5): correo SMTP, Slack webhook, Teams webhook. El canal del equipo sigue pendiente
 * (ESP §12): se elige por configuración del admin; secretos (webhook, credencial SMTP) solo por referencia.
 * Resultado clasificado para el outbox: entregada, ambigua (canal sin confirmación idempotente, ESP §13.8),
 * reintentable o permanente (sin bucle infinito).
 * RF-NOT-01, RF-NOT-02.
 */
import type { NotificationChannelKind } from '@katalyst/shared';

/** Mensaje ya sanitizado: resumen + enlace autenticado al panel; sin secretos ni datos de clientes. */
export interface NotificationMessage {
  subject: string;
  /** Texto plano (correo/Slack/Teams). */
  text: string;
  /** Enlace autenticado al panel (requiere sesión; no contiene credenciales). */
  link: string | null;
  /** Hechos clave/valor para tarjetas (Slack/Teams). */
  facts: { name: string; value: string }[];
  severity: 'info' | 'warning' | 'error';
}

/** Destino resuelto en tiempo de envío. `secret` nunca se registra. */
export interface NotificationTarget {
  kind: NotificationChannelKind;
  /** Webhook (Slack/Teams) o credencial SMTP (`usuario:clave` o JSON `{user,pass}`). */
  secret: string | null;
  recipients: string[];
  smtp: { host: string; port: number; from: string; secure: boolean } | null;
}

export type SendOutcome = 'entregada' | 'ambigua' | 'reintentable' | 'permanente';

export interface SendResult {
  outcome: SendOutcome;
  /** Mensaje sanitizado (sin URL del webhook ni credenciales). */
  message: string;
  httpStatus?: number;
  retryAfterMs?: number;
  externalId?: string;
}

export interface Notifier {
  readonly kind: NotificationChannelKind;
  send(message: NotificationMessage, target: NotificationTarget): Promise<SendResult>;
}
