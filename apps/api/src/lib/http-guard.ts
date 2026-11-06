/**
 * Cliente HTTP saliente protegido (TestRail, Git): timeouts, límite de respuesta, redirecciones manuales validadas y
 * resolución DNS verificada en el momento de conectar (anti DNS-rebinding). ESP §13.7, §8, RNF-SEG-03.
 * - Cada salto de redirección pasa otra vez por `assertUrlAllowed` + `resolveAndCheck`.
 * - Las credenciales (`Authorization`) se eliminan si una redirección cambia de origen.
 * - Distingue timeout **ambiguo** (la solicitud se envió completa y no hubo respuesta): el llamador no debe repetir
 *   a ciegas operaciones no idempotentes (ESP §13.4).
 * Nunca registra cuerpos ni encabezados.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { assertUrlAllowed, resolveAndCheck, type LookupFn, type SsrfPolicy } from './ssrf.js';

export interface GuardedRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Timeout total (conexión + respuesta completa). */
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface GuardedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  url: string;
  text(): string;
  json<T = unknown>(): T;
}

export type HttpGuardErrorCode = 'timeout' | 'network' | 'too_large' | 'too_many_redirects' | 'aborted';

export class HttpGuardError extends Error {
  constructor(
    readonly code: HttpGuardErrorCode,
    /** `true` si la solicitud pudo haberse aplicado en el destino (cuerpo enviado sin respuesta). */
    readonly ambiguous: boolean,
    message?: string,
  ) {
    super(message ?? `HTTP saliente: ${code}`);
    this.name = 'HttpGuardError';
  }
}

export interface HttpGuardOptions {
  policy: SsrfPolicy;
  defaultTimeoutMs?: number;
  lookup?: LookupFn;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class HttpGuard {
  constructor(private readonly opts: HttpGuardOptions) {}

  async request(rawUrl: string, req: GuardedRequest = {}): Promise<GuardedResponse> {
    const maxRedirects = req.maxRedirects ?? 3;
    const timeoutMs = req.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let url = assertUrlAllowed(rawUrl, this.opts.policy);
    let method = req.method ?? 'GET';
    let body = req.body;
    let headers = { ...(req.headers ?? {}) };
    for (let hop = 0; ; hop++) {
      const res = await this.once(url, { ...req, method, body, headers }, deadline);
      const location = res.headers.location;
      if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
      if (hop >= maxRedirects) throw new HttpGuardError('too_many_redirects', false);
      const next = assertUrlAllowed(new URL(location, url), this.opts.policy);
      if (next.origin !== url.origin) {
        // No reenviar credenciales a otro origen.
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase())),
        );
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => !['content-type', 'content-length'].includes(k.toLowerCase())),
        );
      }
      url = next;
    }
  }

  private once(url: URL, req: GuardedRequest, deadline: number): Promise<GuardedResponse> {
    const policy = this.opts.policy;
    const lookupImpl = this.opts.lookup;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new HttpGuardError('timeout', false));
    const maxBytes = req.maxResponseBytes ?? 20 * 1024 * 1024;

    // `lookup` validado: la IP usada para conectar es la verificada.
    const lookup: LookupFunction = (hostname, options, callback) => {
      resolveAndCheck(hostname, policy, lookupImpl)
        .then((addrs) => {
          const family = typeof options === 'object' && options ? (options as { family?: number }).family : undefined;
          const pick = addrs.find((a) => !family || a.family === family) ?? addrs[0]!;
          if ((options as { all?: boolean } | undefined)?.all) {
            (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs);
          } else {
            callback(null, pick.address, pick.family);
          }
        })
        .catch((e: Error) => callback(e as NodeJS.ErrnoException, '', 0));
    };

    return new Promise<GuardedResponse>((resolvePromise, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      let sent = false;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const r = mod.request(
        url,
        {
          method: req.method ?? 'GET',
          headers: {
            'user-agent': 'katalyst-qa-runner',
            ...(req.body !== undefined ? { 'content-length': String(Buffer.byteLength(req.body)) } : {}),
            ...req.headers,
          },
          lookup,
          // Sin agente compartido: cada conexión resuelve y valida de nuevo.
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              r.destroy();
              finish(() => reject(new HttpGuardError('too_large', false)));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            finish(() =>
              resolvePromise({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body,
                url: url.toString(),
                text: () => body.toString('utf8'),
                json: <T>() => JSON.parse(body.toString('utf8')) as T,
              }),
            );
          });
          res.on('error', () => finish(() => reject(new HttpGuardError('network', sent))));
        },
      );
      const onAbort = () => {
        r.destroy();
        finish(() => reject(new HttpGuardError('aborted', sent)));
      };
      const timer = setTimeout(() => {
        r.destroy();
        // Si el cuerpo ya se envió, el destino pudo aplicar la operación: timeout ambiguo.
        finish(() => reject(new HttpGuardError('timeout', sent && (req.method ?? 'GET') !== 'GET')));
      }, remaining);
      req.signal?.addEventListener('abort', onAbort, { once: true });
      r.on('finish', () => {
        sent = true;
      });
      r.on('error', (e: Error) => {
        if (e && 'code' in e && (e as { code?: string }).code === 'HOST_NOT_ALLOWED') {
          finish(() => reject(e));
          return;
        }
        if ((e as { name?: string }).name === 'SsrfBlockedError') {
          finish(() => reject(e));
          return;
        }
        finish(() => reject(new HttpGuardError('network', sent && (req.method ?? 'GET') !== 'GET')));
      });
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
  }
}

/** Codifica un cuerpo multipart/form-data con un único archivo (adjuntos de TestRail). */
export function multipartBody(
  field: string,
  fileName: string,
  contentType: string,
  content: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `----katalyst${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${safeName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}
