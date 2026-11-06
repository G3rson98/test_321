/**
 * Cifrado de la credencial de dispositivo con el almacén del SO vía Electron `safeStorage`
 * con las API asíncronas (Windows: DPAPI del usuario; macOS: Keychain; Linux: libsecret/kwallet). En Linux sin llavero real
 * (`basic_text`) se considera NO disponible y la credencial no se persiste. ESP §13.6, RNF-SEG-01.
 */
import { safeStorage } from 'electron';
import type { Encryptor } from '../core/credential-store.js';

export const electronEncryptor: Encryptor = {
  async isAvailable(): Promise<boolean> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  },
  encrypt(plain: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(plain);
  },
  async decrypt(data: Buffer): Promise<string> {
    return (await safeStorage.decryptStringAsync(data)).result;
  },
};
