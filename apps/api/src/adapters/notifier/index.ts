/**
 * Registro de notificadores por canal (correo, Slack, Teams) + implementación en memoria para pruebas.
 * RF-NOT-01, RF-NOT-02.
 */
import type { NotificationChannelKind } from '@katalyst/shared';
import { apiCSettings } from '../../modules/recordings/settings.js';
import { SmtpNotifier } from './smtp.js';
import type { NotificationMessage, NotificationTarget, Notifier, SendResult } from './types.js';
import { SlackNotifier, TeamsNotifier, type WebhookNotifierOptions } from './webhook.js';

export * from './types.js';
export { SmtpNotifier, parseSmtpCredentials, renderEmailText } from './smtp.js';
export { SlackNotifier, TeamsNotifier, slackPayload, teamsPayload, postWebhook } from './webhook.js';

export type NotifierRegistry = Record<NotificationChannelKind, Notifier>;

export function createNotifiers(opts: { webhook?: WebhookNotifierOptions } = {}): NotifierRegistry {
  return {
    correo: new SmtpNotifier(),
    slack: new SlackNotifier(opts.webhook),
    teams: new TeamsNotifier(opts.webhook),
  };
}

let override: NotifierRegistry | undefined;
/** Registro del proceso (sustituible en pruebas). En desarrollo puede permitir webhooks locales (loopback/http). */
export function getNotifiers(): NotifierRegistry {
  if (!override) {
    const devLoopback = apiCSettings().NOTIFIER_WEBHOOK_ALLOW_LOOPBACK && process.env.NODE_ENV !== 'production';
    override = createNotifiers(
      devLoopback
        ? { webhook: { policy: { allowedHosts: [], allowedSchemes: ['https', 'http'], allowLoopback: true } } }
        : {},
    );
  }
  return override;
}
export function setNotifiers(r: NotifierRegistry | undefined): void {
  override = r;
}

/** Notificador en memoria: registra mensajes (sin secretos) y devuelve resultados programables. */
export class FakeNotifier implements Notifier {
  readonly sent: { message: NotificationMessage; recipients: string[]; hasSecret: boolean }[] = [];
  private queue: SendResult[] = [];
  constructor(readonly kind: NotificationChannelKind) {}
  enqueueResult(...r: SendResult[]): void {
    this.queue.push(...r);
  }
  async send(message: NotificationMessage, target: NotificationTarget): Promise<SendResult> {
    this.sent.push({ message, recipients: [...target.recipients], hasSecret: Boolean(target.secret) });
    return this.queue.shift() ?? { outcome: 'entregada', message: 'Entregada (fake)' };
  }
}

export function createFakeNotifiers(): { correo: FakeNotifier; slack: FakeNotifier; teams: FakeNotifier; all: FakeNotifier[] } {
  const correo = new FakeNotifier('correo');
  const slack = new FakeNotifier('slack');
  const teams = new FakeNotifier('teams');
  return { correo, slack, teams, all: [correo, slack, teams] };
}
