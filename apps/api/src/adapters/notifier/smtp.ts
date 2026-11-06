/**
 * Correo SMTP con nodemailer (canal configurable por admin; credencial por referencia de secreto, ESP §12/§13.7).
 * Clasificación: aceptado → entregada; conexión rechazada/4xx SMTP → reintentable; 5xx/autenticación → permanente;
 * timeout durante DATA → ambigua. Nunca se registran credenciales ni el cuerpo.
 * RF-NOT-01, RF-NOT-02, RF-NOT-03.
 */
import nodemailer from 'nodemailer';
import type { NotificationMessage, NotificationTarget, Notifier, SendResult } from './types.js';

export function parseSmtpCredentials(secret: string | null): { user: string; pass: string } | null {
  if (!secret) return null;
  const s = secret.trim();
  if (s.startsWith('{')) {
    try {
      const v = JSON.parse(s) as { user?: unknown; pass?: unknown };
      if (typeof v.user === 'string' && typeof v.pass === 'string') return { user: v.user, pass: v.pass };
    } catch {
      return null;
    }
    return null;
  }
  const i = s.indexOf(':');
  return i > 0 ? { user: s.slice(0, i), pass: s.slice(i + 1) } : null;
}

export function renderEmailText(m: NotificationMessage): string {
  const facts = m.facts.map((f) => `${f.name}: ${f.value}`).join('\n');
  return [m.text, facts, m.link ? `Ver en Katalyst (requiere iniciar sesión): ${m.link}` : '']
    .filter(Boolean)
    .join('\n\n');
}

export interface SmtpNotifierOptions {
  timeoutMs?: number;
  /** Fábrica de transporte (pruebas). */
  createTransport?: typeof nodemailer.createTransport;
}

export class SmtpNotifier implements Notifier {
  readonly kind = 'correo' as const;
  constructor(private readonly opts: SmtpNotifierOptions = {}) {}

  async send(message: NotificationMessage, target: NotificationTarget): Promise<SendResult> {
    if (!target.smtp) return { outcome: 'permanente', message: 'SMTP no configurado' };
    if (target.recipients.length === 0) return { outcome: 'entregada', message: 'Sin destinatarios' };
    const auth = parseSmtpCredentials(target.secret);
    const timeout = this.opts.timeoutMs ?? 15_000;
    const create = this.opts.createTransport ?? nodemailer.createTransport.bind(nodemailer);
    const transport = create({
      host: target.smtp.host,
      port: target.smtp.port,
      secure: target.smtp.secure && target.smtp.port === 465,
      requireTLS: target.smtp.secure && target.smtp.port !== 465,
      ...(auth ? { auth } : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      logger: false,
      debug: false,
    });
    try {
      const info = await transport.sendMail({
        from: target.smtp.from,
        // Destinatarios en copia oculta: no exponer la lista del equipo.
        to: target.smtp.from,
        bcc: target.recipients,
        subject: message.subject,
        text: renderEmailText(message),
      });
      const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
      if (rejected > 0 && rejected >= target.recipients.length) {
        return { outcome: 'permanente', message: 'El servidor SMTP rechazó a todos los destinatarios' };
      }
      return { outcome: 'entregada', message: 'Aceptado por el servidor SMTP', externalId: String(info.messageId ?? '') };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; command?: string };
      if (e.code === 'EAUTH') return { outcome: 'permanente', message: 'Autenticación SMTP rechazada' };
      if (typeof e.responseCode === 'number') {
        if (e.responseCode >= 500) return { outcome: 'permanente', message: `SMTP rechazó el mensaje (${e.responseCode})` };
        return { outcome: 'reintentable', message: `SMTP respondió ${e.responseCode}` };
      }
      if (e.code === 'ETIMEDOUT' && e.command === 'DATA') {
        return { outcome: 'ambigua', message: 'Entrega ambigua: SMTP no confirmó a tiempo' };
      }
      return { outcome: 'reintentable', message: 'No se pudo conectar con el servidor SMTP' };
    } finally {
      transport.close();
    }
  }
}
