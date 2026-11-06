/**
 * Enrutador IPC con validación Zod de cada mensaje y verificación del remitente (RNF-SEG-01, ESP §4):
 * - Solo canales de la allowlist (`IPC_COMMANDS`); cualquier otro se rechaza.
 * - Solo el frame principal de la ventana de la app (URL propia) puede invocar comandos.
 * - Payload validado con el esquema estricto del canal (claves desconocidas ⇒ rechazo).
 * - Errores devueltos como `{ ok:false, error:{code,message} }` en español, sin trazas ni datos sensibles.
 * Sin dependencias de Electron (probado en Vitest).
 */
import type { z } from 'zod';
import { ALL_COMMANDS, type IpcCommand } from '../../shared/channels.js';
import { IPC_REQUEST_SCHEMAS, type IpcResult } from '../../shared/ipc.js';
import { ApiError } from '../core/api-client.js';
import { RecorderError, isRecorderError } from '../core/errors.js';
import { errorMessage } from '../core/app-controller.js';

export type IpcHandlers = {
  [C in IpcCommand]: (payload: z.output<(typeof IPC_REQUEST_SCHEMAS)[C]>) => Promise<unknown>;
};

export interface IpcSender {
  /** URL del frame que envía (event.senderFrame.url). */
  frameUrl: string | null;
  /** ¿Es el frame principal de la ventana de la app? */
  isMainFrame: boolean;
  /** ¿El WebContents emisor es la ventana principal registrada? */
  isAppWindow: boolean;
}

export function createIpcRouter(handlers: IpcHandlers, isTrustedUrl: (url: string) => boolean) {
  const allowed = new Set<string>(ALL_COMMANDS);
  return async function dispatch(channel: string, sender: IpcSender, payload: unknown): Promise<IpcResult<unknown>> {
    if (!allowed.has(channel)) return fail('IPC_INVALID', 'Canal no permitido.');
    if (!sender.isAppWindow || !sender.isMainFrame || !sender.frameUrl || !isTrustedUrl(sender.frameUrl)) {
      return fail('IPC_INVALID', 'Remitente no autorizado.');
    }
    const command = channel as IpcCommand;
    const schema = IPC_REQUEST_SCHEMAS[command] as z.ZodType;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return fail('IPC_INVALID', new RecorderError('IPC_INVALID').message);
    try {
      const handler = handlers[command] as (p: unknown) => Promise<unknown>;
      const data = await handler(parsed.data);
      return { ok: true, data: data ?? null };
    } catch (e) {
      if (isRecorderError(e)) return fail(e.code, e.message);
      if (e instanceof ApiError) return fail(e.status === 0 ? 'NETWORK_ERROR' : 'API_ERROR', errorMessage(e));
      return fail('INTERNAL', new RecorderError('INTERNAL').message);
    }
  };
}

function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}
