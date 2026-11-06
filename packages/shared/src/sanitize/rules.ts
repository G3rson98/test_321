/**
 * Reglas de detección/enmascaramiento de datos sensibles (ESP §13.7, RNF-SEG-01, RNF-SEG-02).
 * Detecta: JWT, Bearer/Basic, cookies, AWS keys, claves privadas, credenciales en URL, pares clave=valor sensibles,
 * tokens de proveedores (GitHub, Slack, Anthropic), correos y canarios `KATALYST_CANARY_*`.
 * Los hallazgos nunca incluyen el valor detectado.
 */

export const FINDING_KINDS = [
  'jwt',
  'bearer',
  'basic_auth',
  'cookie',
  'aws_access_key',
  'aws_secret_key',
  'private_key',
  'url_credentials',
  'secret_assignment',
  'provider_token',
  'email',
  'canary',
  'known_secret',
  'sensitive_key',
  'sensitive_query',
  'sensitive_header',
  'input_value',
  'depth_exceeded',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  /** Ruta en JSON (`a.b[0].c`), nombre de encabezado/parámetro o `texto`. */
  location: string;
  count: number;
}

export const REDACTED = '[REDACTED]';
export const redactedFor = (kind: FindingKind): string => `[REDACTED:${kind}]`;
const PLACEHOLDER_RE = /^\[REDACTED(?::[a-z_]+)?\]$/;
export function isPlaceholder(v: string): boolean {
  let s = v.trim().replace(/^["']|["']$/g, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    // valor no decodificable: se evalúa tal cual
  }
  return PLACEHOLDER_RE.test(s);
}

/** Nombres de clave/parámetro/encabezado sensibles (comparación normalizada sin `-`/`_`, minúsculas). */
const SENSITIVE_NAME_PARTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'session',
  'sessionid',
  'credential',
  'privatekey',
  'signature',
  'sig',
  'jwt',
  'otp',
  'mfa',
  'storagestate',
  'xamzsecuritytoken',
  'xamzcredential',
  'xamzsignature',
  'clientsecret',
  'code',
];
/** Coincidencia exacta (no subcadena) para nombres cortos ambiguos. */
const EXACT_ONLY = new Set(['sig', 'code', 'auth', 'otp', 'mfa', 'pwd']);
/** Excepciones conocidas no sensibles. */
const SAFE_NAMES = new Set([
  'statuscode',
  'typeoperation',
  'zipcode',
  'countrycode',
  'errorcode',
  'tokentype',
  'authorid',
  'author',
]);

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveName(name: string): boolean {
  const n = normalizeName(name);
  if (!n || SAFE_NAMES.has(n)) return false;
  for (const part of SENSITIVE_NAME_PARTS) {
    if (EXACT_ONLY.has(part)) {
      if (n === part) return true;
    } else if (n.includes(part)) {
      return true;
    }
  }
  return false;
}

interface TextRule {
  kind: FindingKind;
  re: RegExp;
  /** Devuelve el reemplazo o `null` si la coincidencia ya está enmascarada/no aplica. */
  replace: (match: string, groups: string[]) => string | null;
}

const EMAIL_EXCLUDED_TLDS = 'png|jpe?g|gif|svg|webp|ico|js|mjs|cjs|css|map|json|ts|tsx|html?|txt|zip|woff2?';

export const TEXT_RULES: readonly TextRule[] = [
  {
    kind: 'private_key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => redactedFor('private_key'),
  },
  {
    kind: 'canary',
    re: /KATALYST_CANARY_[A-Za-z0-9_-]+/g,
    replace: () => redactedFor('canary'),
  },
  {
    kind: 'url_credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/?#@]+):([^\s/?#@]+)@/gi,
    replace: (_m, g) => `${g[0]}${redactedFor('url_credentials')}@`,
  },
  {
    kind: 'bearer',
    re: /\b(Bearer)\s+([A-Za-z0-9\-._~+/]+=*)/gi,
    replace: (m, g) => (isPlaceholder(g[1] ?? '') ? null : `${g[0]} ${redactedFor('bearer')}`),
  },
  {
    kind: 'basic_auth',
    re: /\b(Basic)\s+([A-Za-z0-9+/]{8,}={0,2})/g,
    replace: (_m, g) => `${g[0]} ${redactedFor('basic_auth')}`,
  },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    replace: () => redactedFor('jwt'),
  },
  {
    kind: 'cookie',
    re: /\b((?:Set-)?Cookie)(\s*:\s*)([^\r\n]+)/gi,
    replace: (_m, g) => (isPlaceholder(g[2] ?? '') ? null : `${g[0]}${g[1]}${redactedFor('cookie')}`),
  },
  {
    kind: 'aws_access_key',
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
    replace: () => redactedFor('aws_access_key'),
  },
  {
    kind: 'aws_secret_key',
    re: /\b(aws_?secret_?access_?key|aws_?secret|secretAccessKey)(["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})\b/gi,
    replace: (_m, g) => `${g[0]}${g[1]}${redactedFor('aws_secret_key')}`,
  },
  {
    kind: 'provider_token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,})\b/g,
    replace: () => redactedFor('provider_token'),
  },
  {
    kind: 'secret_assignment',
    // clave sensible seguida de := y un valor (comillas opcionales). Ej.: password=abc, "apiKey": "xyz", token: abc
    re: /(["']?)\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?id|authorization|cookie)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;"'}<>]+)/gi,
    replace: (_m, g) => {
      const value = g[3] ?? '';
      const bare = value.replace(/^["']|["']$/g, '');
      if (bare === '' || isPlaceholder(bare)) return null;
      if (/^(?:null|undefined|true|false)$/i.test(bare)) return null;
      // `Authorization: Bearer <token>`: la regla `bearer` ya enmascaró el token.
      if (/^(?:Bearer|Basic)$/i.test(bare)) return null;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${g[0]}${g[1]}${g[0]}${g[2]}${quote}${redactedFor('secret_assignment')}${quote}`;
    },
  },
  {
    kind: 'email',
    re: new RegExp(
      `\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?!(?:${EMAIL_EXCLUDED_TLDS})\\b)[A-Za-z]{2,24}\\b`,
      'g',
    ),
    replace: () => redactedFor('email'),
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regla para secretos conocidos (p. ej. contraseña del usuario de prueba montada por el supervisor). */
export function knownSecretRule(secrets: readonly string[]): TextRule | null {
  const usable = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  if (usable.length === 0) return null;
  const alternatives = [...usable].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return {
    kind: 'known_secret',
    re: new RegExp(alternatives.join('|'), 'g'),
    replace: () => redactedFor('known_secret'),
  };
}

export interface ApplyResult {
  value: string;
  findings: Finding[];
}

function addFinding(findings: Finding[], kind: FindingKind, location: string, n = 1): void {
  const f = findings.find((x) => x.kind === kind && x.location === location);
  if (f) f.count += n;
  else findings.push({ kind, location, count: n });
}
export { addFinding };

/** Aplica las reglas de texto. `mutate=false` solo detecta. */
export function applyTextRules(
  input: string,
  location: string,
  opts: { knownSecrets?: readonly string[]; mutate: boolean },
): ApplyResult {
  const findings: Finding[] = [];
  const rules: TextRule[] = [];
  const known = knownSecretRule(opts.knownSecrets ?? []);
  if (known) rules.push(known);
  rules.push(...TEXT_RULES);
  let value = input;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    value = value.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const groups = rest.slice(0, -2).map((g) => (typeof g === 'string' ? g : ''));
      const replacement = rule.replace(match, groups);
      if (replacement === null) return match;
      addFinding(findings, rule.kind, location);
      return opts.mutate ? replacement : match;
    });
  }
  return { value, findings };
}
