/* eslint-disable @typescript-eslint/no-explicit-any -- script de aceptación: respuestas JSON sin tipar */
/**
 * Cliente HTTP mínimo de la API de Katalyst para scripts locales (Node 24 con type stripping nativo: solo sintaxis
 * TypeScript borrable). Sesión por cookie + token CSRF del login (ESP §13.7). Nunca imprime cookies ni contraseñas.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
  ms: number;
}

export class KatalystClient {
  baseUrl: string;
  cookie = '';
  csrf = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async login(email: string, password: string): Promise<any> {
    const r = await this.request('POST', '/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login falló: HTTP ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 200)}`);
    this.csrf = r.body?.session?.csrfToken ?? '';
    return r.body;
  }

  async request<T = any>(method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const t0 = performance.now();
    const res = await fetch(`${this.baseUrl}/api/v1${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const ms = performance.now() - t0;
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) {
      const jar = new Map(this.cookie ? this.cookie.split('; ').map((c) => [c.split('=')[0]!, c] as [string, string]) : []);
      for (const sc of setCookies) {
        const kv = sc.split(';')[0]!;
        jar.set(kv.split('=')[0]!, kv);
      }
      this.cookie = [...jar.values()].join('; ');
    }
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* texto plano */
    }
    return { status: res.status, body: parsed as T, headers: res.headers, ms };
  }

  async ok<T = any>(method: string, p: string, body?: unknown, expected: number[] = [200, 201, 202], extraHeaders: Record<string, string> = {}): Promise<T> {
    const r = await this.request<T>(method, p, body, extraHeaders);
    if (!expected.includes(r.status)) {
      throw new Error(`${method} ${p} → HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 600)}`);
    }
    return r.body;
  }

  /** Recorre todas las páginas de un listado keyset (`items`, `nextCursor`). */
  async all<T = any>(p: string, limit = 100): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const sep = p.includes('?') ? '&' : '?';
      const page: any = await this.ok('GET', `${p}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      out.push(...(page.items as T[]));
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string, everyMs = 500): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tiempo agotado (${ms} ms) esperando: ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Lee un archivo KEY=VALUE (stack.env / secrets.env del dev-stack). */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export function stackDir(): string {
  return process.env.KATALYST_STACK_DIR ?? path.join(process.env.TMPDIR ?? '/tmp', 'katalyst-dev-stack');
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('La contraseña del administrador se lee por stdin (redirige un archivo o usa un pipe).');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
