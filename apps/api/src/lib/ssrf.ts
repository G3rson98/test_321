/**
 * Protección SSRF para URLs configurables por admin (ambientes, TestRail) — ESP §13.7, RNF-SEG-03.
 * - Allowlist de esquemas (https; http solo si se habilita explícitamente) y de hosts (exactos o `*.sufijo`).
 * - Bloquea SIEMPRE metadatos de nube (169.254.0.0/16, fd00:ec2::254), y por defecto loopback, RFC1918, CGNAT,
 *   link-local, multicast, reservadas, IPv6 ULA y formas embebidas (IPv4-mapped, NAT64, 6to4).
 * - Excepciones registradas: hosts privados explícitamente permitidos (staging privado) pueden resolver a RFC1918/ULA,
 *   nunca a metadatos; loopback solo con `allowLoopback` (desarrollo/pruebas locales).
 * - La verificación se repite tras cada redirección y sobre TODAS las direcciones resueltas por DNS (http-guard usa
 *   `lookup` validado en la conexión, evitando DNS rebinding entre verificación y uso).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { KatalystError } from '@katalyst/shared';

export interface SsrfPolicy {
  /** Hosts permitidos (`host`, `*.dominio`). Vacío = sin restricción de nombre (las reglas de IP siguen aplicando). */
  allowedHosts: readonly string[];
  /** Esquemas permitidos; por defecto solo `https`. */
  allowedSchemes?: readonly ('http' | 'https')[];
  /** Excepciones registradas: hosts que pueden resolver a redes privadas (RFC1918/ULA/CGNAT). */
  privateAllowedHosts?: readonly string[];
  /** Permite loopback (solo desarrollo/pruebas con servidores locales). */
  allowLoopback?: boolean;
  /** Puertos permitidos; vacío = cualquiera. */
  allowedPorts?: readonly number[];
}

export type IpCategory =
  | 'public'
  | 'metadata'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'multicast'
  | 'reserved'
  | 'unspecified';

export class SsrfBlockedError extends KatalystError {
  constructor(
    readonly reason: 'scheme' | 'host' | 'port' | 'ip' | 'dns' | 'credentials' | 'invalid_url',
    readonly category?: IpCategory,
  ) {
    super('HOST_NOT_ALLOWED', undefined, { reasons: [reason, ...(category ? [category] : [])] });
    this.name = 'SsrfBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Clasificación de IP
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inV4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

export function classifyIpv4(ip: string): IpCategory {
  const n = ipv4ToInt(ip);
  if (inV4(n, '169.254.0.0', 16)) return inV4(n, '169.254.169.254', 32) ? 'metadata' : 'link_local';
  if (inV4(n, '0.0.0.0', 8)) return 'unspecified';
  if (inV4(n, '127.0.0.0', 8)) return 'loopback';
  if (inV4(n, '10.0.0.0', 8) || inV4(n, '172.16.0.0', 12) || inV4(n, '192.168.0.0', 16)) return 'private';
  if (inV4(n, '100.64.0.0', 10)) return 'cgnat';
  if (inV4(n, '224.0.0.0', 4)) return 'multicast';
  if (
    inV4(n, '240.0.0.0', 4) ||
    inV4(n, '192.0.0.0', 24) ||
    inV4(n, '192.0.2.0', 24) ||
    inV4(n, '198.18.0.0', 15) ||
    inV4(n, '198.51.100.0', 24) ||
    inV4(n, '203.0.113.0', 24)
  )
    return 'reserved';
  return 'public';
}

/** Expande una IPv6 a 8 grupos de 16 bits (admite `::` y sufijo IPv4). */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, -v4[1]!.length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(':').map((x) => parseInt(x, 16)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

export function classifyIpv6(ip: string): IpCategory {
  const g = expandIpv6(ip);
  if (!g) return 'reserved';
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return 'unspecified';
  if (allZero(0, 7) && g[7] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d y IPv4-compatible ::a.b.c.d
  if (allZero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return classifyIpv4(v4FromGroups(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return classifyIpv4(v4FromGroups(g[6]!, g[7]!));
  // 6to4 2002::/16 (IPv4 embebida en grupos 1-2)
  if (g[0] === 0x2002) return classifyIpv4(v4FromGroups(g[1]!, g[2]!)) === 'public' ? 'public' : 'reserved';
  // Metadatos AWS IPv6 fd00:ec2::254
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && allZero(2, 7) && g[7] === 0x254) return 'metadata';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'private';
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link_local';
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'reserved';
  return 'public';
}

export function classifyIp(ip: string): IpCategory {
  const v = isIP(ip);
  if (v === 4) return classifyIpv4(ip);
  if (v === 6) return classifyIpv6(ip);
  return 'reserved';
}

/** IP de cliente interna (loopback o red privada): usado para restringir `/metrics`. */
export function isInternalClientIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const c = classifyIp(ip);
  return c === 'loopback' || c === 'private' || c === 'link_local' || c === 'cgnat';
}

// ---------------------------------------------------------------------------
// Políticas
// ---------------------------------------------------------------------------

export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** ¿`host` coincide con algún patrón (`exacto` o `*.sufijo`, que no incluye el apex)? */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = normalizeHost(host);
  return patterns.some((raw) => {
    const p = normalizeHost(raw);
    if (!p) return false;
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

/** Valida patrón de host de allowlist (`dominio` o `*.dominio`, sin puertos/rutas). */
export function isValidHostPattern(p: string): boolean {
  const s = p.trim().toLowerCase();
  if (isIP(s.replace(/^\[|\]$/g, ''))) return true;
  return /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s);
}

/** ¿Se admite esta categoría de IP para el host dado? */
export function ipAllowed(category: IpCategory, host: string, policy: SsrfPolicy): boolean {
  switch (category) {
    case 'public':
      return true;
    case 'metadata':
    case 'unspecified':
    case 'multicast':
    case 'reserved':
      return false;
    case 'loopback':
      return policy.allowLoopback === true;
    case 'link_local':
      return false;
    case 'private':
    case 'cgnat':
      return hostMatches(host, policy.privateAllowedHosts ?? []);
  }
}

/** Valida forma de la URL (esquema, credenciales, host en allowlist, puerto, IP literal). No resuelve DNS. */
export function assertUrlAllowed(rawUrl: string | URL, policy: SsrfPolicy): URL {
  let url: URL;
  try {
    url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl;
  } catch {
    throw new SsrfBlockedError('invalid_url');
  }
  const scheme = url.protocol.replace(/:$/, '');
  const schemes = policy.allowedSchemes ?? ['https'];
  if (!(schemes as readonly string[]).includes(scheme)) throw new SsrfBlockedError('scheme');
  if (url.username || url.password) throw new SsrfBlockedError('credentials');
  const host = normalizeHost(url.hostname);
  if (!host) throw new SsrfBlockedError('invalid_url');
  if (policy.allowedHosts.length > 0 && !hostMatches(host, policy.allowedHosts)) throw new SsrfBlockedError('host');
  const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
  if (policy.allowedPorts && policy.allowedPorts.length > 0 && !policy.allowedPorts.includes(port)) {
    throw new SsrfBlockedError('port');
  }
  if (isIP(host)) {
    const cat = classifyIp(host);
    if (!ipAllowed(cat, host, policy)) throw new SsrfBlockedError('ip', cat);
  } else if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!policy.allowLoopback) throw new SsrfBlockedError('ip', 'loopback');
  }
  return url;
}

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** Resuelve el host y exige que TODAS las direcciones estén permitidas. Devuelve las direcciones válidas. */
export async function resolveAndCheck(
  host: string,
  policy: SsrfPolicy,
  lookup: LookupFn = defaultLookup,
): Promise<{ address: string; family: number }[]> {
  const h = normalizeHost(host);
  if (isIP(h)) {
    const cat = classifyIp(h);
    if (!ipAllowed(cat, h, policy)) throw new SsrfBlockedError('ip', cat);
    return [{ address: h, family: isIP(h) }];
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(h);
  } catch {
    throw new SsrfBlockedError('dns');
  }
  if (addrs.length === 0) throw new SsrfBlockedError('dns');
  for (const a of addrs) {
    const cat = classifyIp(a.address);
    if (!ipAllowed(cat, h, policy)) throw new SsrfBlockedError('ip', cat);
  }
  return addrs;
}

/** Validación completa (forma + DNS) para guardar configuraciones. */
export async function assertUrlSafe(rawUrl: string, policy: SsrfPolicy, lookup?: LookupFn): Promise<URL> {
  const url = assertUrlAllowed(rawUrl, policy);
  await resolveAndCheck(url.hostname, policy, lookup);
  return url;
}

/** Política de destinos (ambientes/TestRail) a partir de la configuración del proceso. */
export function policyFromConfig(config: {
  ALLOWED_TARGET_HOSTS: string[];
  SSRF_PRIVATE_ALLOWED_HOSTS: string[];
  SSRF_ALLOW_LOOPBACK: boolean;
  SSRF_ALLOW_HTTP: boolean;
}): SsrfPolicy {
  return {
    allowedHosts: config.ALLOWED_TARGET_HOSTS,
    privateAllowedHosts: config.SSRF_PRIVATE_ALLOWED_HOSTS,
    allowLoopback: config.SSRF_ALLOW_LOOPBACK,
    allowedSchemes: config.SSRF_ALLOW_HTTP ? ['https', 'http'] : ['https'],
  };
}
