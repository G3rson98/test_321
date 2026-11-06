/**
 * Proveedores de identidad del panel (RF-USR-01). Decisión externa pendiente (ESP §12 "Login al panel"): se entregan
 * - `LocalIdentityProvider`: correo + contraseña argon2id (usuarios propios),
 * - `OidcIdentityProvider`: IdP corporativo opcional (Authorization Code + PKCE + `state`/`nonce`), configurable por
 *   `OIDC_ISSUER_URL`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET_REF`/`OIDC_REDIRECT_URL`. No auto-aprovisiona usuarios:
 *   el admin crea el `panel_user` (rol) y el primer login enlaza `auth_subject` por correo verificado.
 * La sesión siempre es del backend (`panel_session`); los tokens del IdP no llegan al navegador.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PanelRole, PrismaClient } from '@prisma/client';
import { HttpGuard } from '../../lib/http-guard.js';
import type { SecretProvider } from '../../lib/secrets.js';
import { verifyPassword, burnPasswordVerification } from '../../lib/crypto-tokens.js';

export interface IdentityResult {
  userId: string;
  email: string;
}

export interface IdentityProvider {
  readonly id: 'local' | 'oidc';
  readonly displayName: string;
}

export class LocalIdentityProvider implements IdentityProvider {
  readonly id = 'local' as const;
  readonly displayName = 'Correo y contraseña';
  constructor(private readonly prisma: PrismaClient) {}

  /** Devuelve el usuario si la contraseña es correcta (aunque esté deshabilitado: el llamador decide). */
  async verify(
    email: string,
    password: string,
  ): Promise<
    | { ok: true; user: { id: string; email: string; role: PanelRole; disabledAt: Date | null; passwordHash: string } }
    | { ok: false; userId: string | null }
  > {
    const user = await this.prisma.panelUser.findUnique({
      where: { email },
      select: { id: true, email: true, role: true, disabledAt: true, passwordHash: true },
    });
    if (!user || !user.passwordHash) {
      await burnPasswordVerification(password);
      return { ok: false, userId: user?.id ?? null };
    }
    const ok = await verifyPassword(user.passwordHash, password);
    return ok ? { ok: true, user: { ...user, passwordHash: user.passwordHash } } : { ok: false, userId: user.id };
  }
}

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecretRef?: string | undefined;
  redirectUrl: string;
  scopes?: string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export interface OidcLoginStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export class OidcIdentityProvider implements IdentityProvider {
  readonly id = 'oidc' as const;
  readonly displayName = 'SSO corporativo';
  private discovery: Discovery | undefined;

  constructor(
    private readonly cfg: OidcConfig,
    private readonly secrets: SecretProvider,
    private readonly http: HttpGuard = new HttpGuard({
      policy: { allowedHosts: [new URL(cfg.issuerUrl).hostname], allowedSchemes: ['https'] },
    }),
  ) {}

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const res = await this.http.request(`${this.cfg.issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      timeoutMs: 10_000,
    });
    if (res.status !== 200) throw new Error('OIDC discovery falló');
    const d = res.json<Discovery>();
    if (!d.authorization_endpoint || !d.token_endpoint || !d.userinfo_endpoint) throw new Error('OIDC discovery incompleto');
    this.discovery = d;
    return d;
  }

  async beginLogin(): Promise<OidcLoginStart> {
    const d = await this.discover();
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const url = new URL(d.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUrl);
    url.searchParams.set('scope', (this.cfg.scopes ?? ['openid', 'email', 'profile']).join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state, nonce, codeVerifier };
  }

  /** Intercambia el código y obtiene `sub`/correo verificado vía userinfo (canal TLS al IdP). */
  async completeLogin(code: string, codeVerifier: string): Promise<{ subject: string; email: string | null }> {
    const d = await this.discover();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUrl,
      client_id: this.cfg.clientId,
      code_verifier: codeVerifier,
    });
    if (this.cfg.clientSecretRef) form.set('client_secret', await this.secrets.get(this.cfg.clientSecretRef));
    const tok = await this.http.request(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      timeoutMs: 10_000,
    });
    if (tok.status !== 200) throw new Error('OIDC token endpoint rechazó el código');
    const accessToken = tok.json<{ access_token?: string }>().access_token;
    if (!accessToken) throw new Error('OIDC sin access_token');
    const info = await this.http.request(d.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      timeoutMs: 10_000,
    });
    if (info.status !== 200) throw new Error('OIDC userinfo falló');
    const u = info.json<{ sub?: string; email?: string; email_verified?: boolean }>();
    if (!u.sub) throw new Error('OIDC sin sub');
    return { subject: u.sub, email: u.email && u.email_verified !== false ? u.email.toLowerCase() : null };
  }
}

export function oidcFromConfig(
  config: {
    OIDC_ISSUER_URL?: string | undefined;
    OIDC_CLIENT_ID?: string | undefined;
    OIDC_CLIENT_SECRET_REF?: string | undefined;
    OIDC_REDIRECT_URL?: string | undefined;
  },
  secrets: SecretProvider,
): OidcIdentityProvider | null {
  if (!config.OIDC_ISSUER_URL || !config.OIDC_CLIENT_ID || !config.OIDC_REDIRECT_URL) return null;
  return new OidcIdentityProvider(
    {
      issuerUrl: config.OIDC_ISSUER_URL,
      clientId: config.OIDC_CLIENT_ID,
      clientSecretRef: config.OIDC_CLIENT_SECRET_REF,
      redirectUrl: config.OIDC_REDIRECT_URL,
    },
    secrets,
  );
}
