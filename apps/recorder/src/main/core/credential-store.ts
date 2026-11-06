/**
 * Credencial de dispositivo del asistente (ESP §13.6): se guarda cifrada con el almacén de credenciales del SO
 * (Electron `safeStorage` → DPAPI en Windows, Keychain en macOS, libsecret en Linux) en un archivo de `userData`
 * con permisos 0600. Si el SO no ofrece cifrado real, NO se persiste en claro (queda solo en memoria).
 * Es revocable: `clear()` local + `DELETE /devices/{id}`; un 401 de la API también la borra.
 * Es autenticación del asistente, nunca sesión del sistema bajo prueba. RF-GRB-01, RNF-SEG-01.
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { RecorderError } from './errors.js';

export interface Encryptor {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

export const DeviceCredentialSchema = z.object({
  accessToken: z.string().min(32),
  deviceId: z.uuid(),
  expiresAt: z.string(),
  serverUrl: z.string(),
  linkedAt: z.string(),
});
export type DeviceCredential = z.infer<typeof DeviceCredentialSchema>;

export class CredentialStore {
  private memory: DeviceCredential | null = null;
  private persistent: boolean | null = null;

  constructor(
    private readonly filePath: string,
    private readonly encryptor: Encryptor,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Consulta (y recuerda) si el SO ofrece cifrado; si no, la credencial solo vive en memoria. */
  async checkPersistent(): Promise<boolean> {
    this.persistent = await this.encryptor.isAvailable().catch(() => false);
    return this.persistent;
  }

  /** Último resultado conocido de `checkPersistent` (falso hasta comprobarlo). */
  isPersistent(): boolean {
    return this.persistent === true;
  }

  async save(cred: DeviceCredential): Promise<void> {
    const valid = DeviceCredentialSchema.parse(cred);
    this.memory = valid;
    if (!(await this.checkPersistent())) return;
    const data = await this.encryptor.encrypt(JSON.stringify(valid));
    await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /** Devuelve la credencial vigente del servidor indicado o `null` (corrupta, vencida u otro servidor ⇒ se borra). */
  async load(serverUrl: string): Promise<DeviceCredential | null> {
    let cred = this.memory;
    if (!cred && (await this.checkPersistent())) {
      let raw: Buffer;
      try {
        raw = await fs.readFile(this.filePath);
      } catch {
        return null;
      }
      try {
        cred = DeviceCredentialSchema.parse(JSON.parse(await this.encryptor.decrypt(raw)));
      } catch {
        await this.clear();
        return null;
      }
    }
    if (!cred) return null;
    if (cred.serverUrl !== serverUrl || Date.parse(cred.expiresAt) <= this.now()) {
      await this.clear();
      return null;
    }
    this.memory = cred;
    return cred;
  }

  async clear(): Promise<void> {
    this.memory = null;
    await fs.rm(this.filePath, { force: true });
    await fs.rm(`${this.filePath}.tmp`, { force: true });
  }

  /** Falla explícitamente si se exige persistencia y el SO no la ofrece. */
  async assertPersistent(): Promise<void> {
    if (!(await this.checkPersistent())) throw new RecorderError('CREDENTIAL_STORE_UNAVAILABLE');
  }
}
