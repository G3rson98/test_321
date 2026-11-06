/**
 * Page Object del login de FMS DeltaX (AWS Cognito). RF-AMB-03; ESP §10 reglas 2, 5 y 12; Bloque 0.
 *
 * Los selectores del formulario NO están confirmados: el login puede ser un formulario propio de la SPA (Amplify) o
 * la Hosted UI de Cognito. Se usan getByLabel/getByRole razonables y cada uno queda marcado como
 * `TODO selector (Bloque 0)`; el validador del manifiesto los reporta como bloqueo de aprobación.
 *
 * Este Page Object nunca registra ni adjunta la contraseña. El proyecto `setup` corre con trace/video/screenshot
 * apagados para que la acción `fill` no quede en artefactos.
 */
import type { Locator, Page, Response } from '@playwright/test';

/** Desafíos de Cognito que NO requieren intervención humana (parte del flujo SRP o del dispositivo recordado). */
const NON_INTERACTIVE_CHALLENGES = new Set(['PASSWORD_VERIFIER', 'DEVICE_SRP_AUTH', 'DEVICE_PASSWORD_VERIFIER']);

const COGNITO_IDP_HOST = /^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/;

export type CognitoSignal =
  | { kind: 'challenge'; challengeName: string }
  | { kind: 'error'; errorType: string }
  | { kind: 'other' };

export class LoginPage {
  readonly page: Page;
  readonly username: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly errorMessage: Locator;
  readonly mfaChallenge: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO selector (Bloque 0): etiqueta real del campo usuario/correo en el login de Cognito/DeltaX.
    this.username = page.getByLabel(/usuario|correo|e-?mail|username/i).first();
    // TODO selector (Bloque 0): etiqueta real del campo contraseña.
    this.password = page.getByLabel(/contraseña|password/i).first();
    // TODO selector (Bloque 0): nombre accesible real del botón de ingreso.
    this.submit = page.getByRole('button', { name: /iniciar sesi[oó]n|ingresar|entrar|acceder|sign in|log ?in/i }).first();
    // TODO selector (Bloque 0): mensaje de credenciales inválidas (rol alert o texto de Cognito).
    this.errorMessage = page
      .getByRole('alert')
      .filter({ hasText: /incorrect|inv[aá]lid|incorrect[oa]s?|no existe|not authorized/i })
      .first();
    // TODO selector (Bloque 0): pantalla de MFA / desafío (código TOTP/SMS, cambio de contraseña obligatorio).
    this.mfaChallenge = page
      .getByLabel(/c[oó]digo|code|verificaci[oó]n|one[- ]time|nueva contraseña|new password/i)
      .or(page.getByText(/autenticaci[oó]n (multifactor|de dos factores)|verification code|MFA|c[oó]digo de verificaci[oó]n/i))
      .first();
  }

  /** Abre la raíz de la app; sin sesión, la SPA presenta (o redirige a) el login. */
  async goto(): Promise<void> {
    await this.page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  async waitForForm(timeout: number): Promise<void> {
    await this.username.waitFor({ state: 'visible', timeout });
    await this.password.waitFor({ state: 'visible', timeout });
  }

  async submitCredentials(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.submit.click();
  }

  /** ¿La respuesta proviene del endpoint de Cognito Identity Provider? */
  static isCognitoResponse(response: Response): boolean {
    try {
      return COGNITO_IDP_HOST.test(new URL(response.url()).hostname);
    } catch {
      return false;
    }
  }

  /**
   * Clasifica una respuesta de Cognito leyendo SOLO `ChallengeName` / `__type`. El resto del cuerpo (tokens en
   * `AuthenticationResult`) se descarta sin registrarse.
   */
  static async readCognitoSignal(response: Response): Promise<CognitoSignal> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'other' };
    }
    if (!body || typeof body !== 'object') return { kind: 'other' };
    const record = body as Record<string, unknown>;
    const challenge = record['ChallengeName'];
    if (typeof challenge === 'string' && !NON_INTERACTIVE_CHALLENGES.has(challenge)) {
      return { kind: 'challenge', challengeName: challenge.replace(/[^A-Z_]/g, '') };
    }
    const errorType = record['__type'];
    if (response.status() >= 400 && typeof errorType === 'string') {
      return { kind: 'error', errorType: errorType.replace(/[^A-Za-z#.]/g, '').split('#').pop() ?? 'desconocido' };
    }
    return { kind: 'other' };
  }
}
