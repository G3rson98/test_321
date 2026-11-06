/**
 * Rate limit y bloqueo progresivo del login propio (ESP §13.7): por cuenta (hash del correo) y por IP.
 * Tras `maxFailures` fallos, cada fallo adicional bloquea `base · 2^(n-max)` s hasta `maxSeconds`. Ventana de conteo
 * 24 h; un login correcto reinicia el contador de la cuenta. Estado en Redis (sobrevive a reinicios de la API y se
 * comparte entre réplicas); si Redis no está disponible, se usa memoria local (degradado, nunca abierto).
 */
import type { Redis } from 'ioredis';
import { hashToken } from '../../lib/crypto-tokens.js';

export interface ThrottleConfig {
  maxFailures: number;
  baseSeconds: number;
  maxSeconds: number;
  /** Multiplicador del umbral para la clave por IP (muchas cuentas desde una IP). */
  ipFactor?: number;
  prefix: string;
}

export interface ThrottleState {
  locked: boolean;
  retryAfterSeconds: number;
}

const WINDOW_SECONDS = 24 * 3600;

export class LoginThrottle {
  private readonly memory = new Map<string, { count: number; lockUntil: number; expires: number }>();
  constructor(
    private readonly redis: Redis | undefined,
    private readonly cfg: ThrottleConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private keys(email: string, ip: string | undefined): { account: string; ip: string | null } {
    return {
      account: `${this.cfg.prefix}:login:acct:${hashToken(`acct:${email.toLowerCase()}`).slice(0, 32)}`,
      ip: ip ? `${this.cfg.prefix}:login:ip:${hashToken(`ip:${ip}`).slice(0, 32)}` : null,
    };
  }

  private async redisReady(): Promise<Redis | null> {
    const r = this.redis;
    if (!r) return null;
    try {
      if (r.status === 'wait' || r.status === 'end') await r.connect();
      return r.status === 'ready' ? r : null;
    } catch {
      return null;
    }
  }

  private lockSeconds(count: number, threshold: number): number {
    if (count < threshold) return 0;
    return Math.min(this.cfg.maxSeconds, this.cfg.baseSeconds * 2 ** (count - threshold));
  }

  async check(email: string, ip: string | undefined): Promise<ThrottleState> {
    const k = this.keys(email, ip);
    const ids = [k.account, ...(k.ip ? [k.ip] : [])];
    const r = await this.redisReady();
    let maxTtl = 0;
    for (const id of ids) {
      if (r) {
        const ttl = await r.pttl(`${id}:lock`);
        if (ttl > maxTtl) maxTtl = ttl;
      } else {
        const m = this.memory.get(id);
        if (m && m.lockUntil > this.now()) maxTtl = Math.max(maxTtl, m.lockUntil - this.now());
      }
    }
    return { locked: maxTtl > 0, retryAfterSeconds: Math.ceil(maxTtl / 1000) };
  }

  async registerFailure(email: string, ip: string | undefined): Promise<ThrottleState> {
    const k = this.keys(email, ip);
    const entries: [string, number][] = [[k.account, this.cfg.maxFailures]];
    if (k.ip) entries.push([k.ip, this.cfg.maxFailures * (this.cfg.ipFactor ?? 4)]);
    const r = await this.redisReady();
    let maxLock = 0;
    for (const [id, threshold] of entries) {
      let count: number;
      if (r) {
        count = await r.incr(id);
        if (count === 1) await r.expire(id, WINDOW_SECONDS);
      } else {
        const m = this.memory.get(id);
        const fresh = !m || m.expires < this.now();
        count = fresh ? 1 : m.count + 1;
        this.memory.set(id, {
          count,
          lockUntil: fresh ? 0 : m.lockUntil,
          expires: fresh ? this.now() + WINDOW_SECONDS * 1000 : m.expires,
        });
      }
      const lock = this.lockSeconds(count, threshold);
      if (lock > 0) {
        if (r) await r.set(`${id}:lock`, '1', 'EX', lock);
        else this.memory.get(id)!.lockUntil = this.now() + lock * 1000;
        maxLock = Math.max(maxLock, lock);
      }
    }
    return { locked: maxLock > 0, retryAfterSeconds: maxLock };
  }

  async registerSuccess(email: string): Promise<void> {
    const k = this.keys(email, undefined);
    const r = await this.redisReady();
    if (r) await r.del(k.account, `${k.account}:lock`);
    else this.memory.delete(k.account);
  }
}
