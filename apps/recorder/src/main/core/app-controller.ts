/**
 * Estado global del asistente: servidor configurado, vínculo por flujo de dispositivo, salud (heartbeat),
 * navegador Chromium, lista de grabaciones del usuario y la grabación abierta. Sin dependencias de Electron.
 * RF-GRB-01, RF-GRB-06, ESP §9 ("estado de salud del asistente vinculado"), §13.6.
 */
import { TERMINAL_RECORDING_STATUSES } from '@katalyst/shared/enums';
import type { AppState, BrowserView, DeviceView, RecordingListView } from '../../shared/ipc.js';
import { ApiError, KatalystApiClient } from './api-client.js';
import { apiBaseUrl, isSafeExternalUrl, normalizeServerUrl } from './config.js';
import type { CredentialStore, DeviceCredential } from './credential-store.js';
import { parseDeepLink } from './deep-link.js';
import {
  pollDeviceToken,
  realClock,
  startDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceFlowClock,
} from './device-flow.js';
import { RecorderError, isRecorderError } from './errors.js';
import { RecordingController, type RecordingControllerDeps } from './recording-controller.js';
import type { SessionStore } from './session-store.js';
import type { FetchLike } from './api-client.js';

export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface ConfigPersistence {
  load(): Promise<{ serverUrl: string | null }>;
  save(cfg: { serverUrl: string | null }): Promise<void>;
}

export interface BrowserManager {
  check(): Promise<{ installed: boolean; source: BrowserView['source'] }>;
  install(): Promise<boolean>;
}

export interface AppControllerDeps {
  version: string;
  platform: 'windows' | 'macos' | 'linux';
  devMode: boolean;
  config: ConfigPersistence;
  credentials: CredentialStore;
  store: SessionStore;
  browser: BrowserManager;
  openExternal: (url: string) => Promise<void>;
  createLoginBrowser: RecordingControllerDeps['createLoginBrowser'];
  createCodegen: RecordingControllerDeps['createCodegen'];
  fetch?: FetchLike;
  clock?: DeviceFlowClock;
  onState: (state: AppState) => void;
}

export class AppController {
  private serverUrl: string | null = null;
  private credential: DeviceCredential | null = null;
  private api: KatalystApiClient | null = null;
  private recording: RecordingController | null = null;
  private device: DeviceView = emptyDevice('sin_configurar');
  private browser: BrowserView = { status: 'desconocido', source: 'ninguno', message: null };
  private pendingRecordingId: string | null = null;
  private notice: AppState['notice'] = null;
  private linkAbort: AbortController | null = null;
  private linkAuth: DeviceAuthorization | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly clock: DeviceFlowClock;

  constructor(private readonly deps: AppControllerDeps) {
    this.clock = deps.clock ?? realClock;
  }

  // ---- Ciclo de vida ------------------------------------------------------------------------------------

  async init(): Promise<void> {
    await this.deps.credentials.checkPersistent();
    const cfg = await this.deps.config.load();
    if (cfg.serverUrl) {
      try {
        this.serverUrl = normalizeServerUrl(cfg.serverUrl, { devMode: this.deps.devMode });
      } catch {
        this.serverUrl = null;
      }
    }
    this.rebuildApi();
    if (this.serverUrl) {
      this.credential = await this.deps.credentials.load(this.serverUrl);
      this.device = emptyDevice(this.credential ? 'vinculado' : 'sin_vincular');
      if (this.credential) this.setLinkedDevice(this.credential);
    }
    await this.refreshBrowser();
    if (this.credential) this.startHeartbeat();
    this.publish();
  }

  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    this.linkAbort?.abort();
    await this.recording?.close().catch(() => undefined);
  }

  get activeRecordingIds(): Set<string> {
    const id = this.recording?.activeId;
    return new Set(id ? [id] : []);
  }

  state(): AppState {
    return {
      version: this.deps.version,
      serverUrl: this.serverUrl,
      devMode: this.deps.devMode,
      credentialStore: this.deps.credentials.isPersistent() ? 'disponible' : 'no_disponible',
      device: this.device,
      browser: this.browser,
      recording: this.recording?.view() ?? null,
      pendingRecordingId: this.pendingRecordingId,
      notice: this.notice,
    };
  }

  private publish(): void {
    this.deps.onState(this.state());
  }

  setNotice(kind: 'info' | 'error', message: string | null): void {
    this.notice = message ? { kind, message } : null;
    this.publish();
  }

  private rebuildApi(): void {
    if (!this.serverUrl) {
      this.api = null;
      this.recording = null;
      return;
    }
    const opts: ConstructorParameters<typeof KatalystApiClient>[0] = {
      baseUrl: apiBaseUrl(this.serverUrl),
      getToken: () => this.credential?.accessToken ?? null,
      userAgent: `KatalystRecorder/${this.deps.version}`,
    };
    if (this.deps.fetch) opts.fetch = this.deps.fetch;
    this.api = new KatalystApiClient(opts);
    this.recording = new RecordingController({
      api: this.api,
      store: this.deps.store,
      createLoginBrowser: this.deps.createLoginBrowser,
      createCodegen: this.deps.createCodegen,
      browserReady: async () => (await this.deps.browser.check()).installed,
      devMode: this.deps.devMode,
      onChange: () => this.publish(),
    });
  }

  private requireApi(): KatalystApiClient {
    if (!this.api || !this.serverUrl) throw new RecorderError('SERVER_NOT_CONFIGURED');
    return this.api;
  }

  private requireLinked(): RecordingController {
    this.requireApi();
    if (!this.credential || !this.recording) throw new RecorderError('NOT_LINKED');
    return this.recording;
  }

  /** Un 401 de la API significa credencial revocada/vencida: se borra localmente. */
  private async handleAuthFailure(e: unknown): Promise<never> {
    if (e instanceof ApiError && e.status === 401 && this.credential) {
      await this.forgetCredential(new RecorderError('DEVICE_REVOKED').message);
      throw new RecorderError('DEVICE_REVOKED');
    }
    throw e;
  }

  // ---- Configuración ---------------------------------------------------------------------------------------

  async setServerUrl(input: string): Promise<void> {
    const normalized = normalizeServerUrl(input, { devMode: this.deps.devMode });
    if (this.recording?.activeId)
      throw new RecorderError('INVALID_STATE', 'Cierra la grabación abierta antes de cambiar el servidor.');
    if (normalized !== this.serverUrl) {
      this.cancelLink();
      await this.forgetCredential(null);
      this.serverUrl = normalized;
      await this.deps.config.save({ serverUrl: normalized });
      this.rebuildApi();
      this.device = emptyDevice('sin_vincular');
    }
    this.publish();
  }

  // ---- Vínculo por flujo de dispositivo ------------------------------------------------------------------

  async startLink(): Promise<void> {
    const api = this.requireApi();
    this.cancelLink();
    const auth = await startDeviceAuthorization(
      api,
      { clientName: 'Asistente de grabación Katalyst', clientVersion: this.deps.version, platform: this.deps.platform },
      this.clock,
    );
    const abort = new AbortController();
    this.linkAbort = abort;
    this.linkAuth = auth;
    this.device = {
      ...emptyDevice('vinculando'),
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      codeExpiresAt: new Date(auth.expiresAtMs).toISOString(),
    };
    this.notice = null;
    this.publish();
    void this.completeLink(api, auth, abort);
  }

  private async completeLink(api: KatalystApiClient, auth: DeviceAuthorization, abort: AbortController): Promise<void> {
    try {
      const token = await pollDeviceToken(api, auth, this.clock, { signal: abort.signal });
      if (abort.signal.aborted || !this.serverUrl) return;
      const cred: DeviceCredential = {
        accessToken: token.accessToken,
        deviceId: token.deviceId,
        expiresAt: token.expiresAt,
        serverUrl: this.serverUrl,
        linkedAt: new Date(this.clock.now()).toISOString(),
      };
      await this.deps.credentials.save(cred);
      this.credential = cred;
      this.setLinkedDevice(cred);
      this.notice = this.deps.credentials.isPersistent()
        ? { kind: 'info', message: 'Asistente vinculado.' }
        : {
            kind: 'error',
            message: 'Asistente vinculado solo hasta cerrarlo: el sistema no ofrece almacén de credenciales.',
          };
      this.startHeartbeat();
      this.publish();
      void this.heartbeat();
      if (this.pendingRecordingId) {
        const id = this.pendingRecordingId;
        this.pendingRecordingId = null;
        await this.openRecording(id).catch((e: unknown) => this.setNotice('error', errorMessage(e)));
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      this.device = { ...emptyDevice('sin_vincular'), message: errorMessage(e) };
      this.publish();
    } finally {
      if (this.linkAbort === abort) {
        this.linkAbort = null;
        this.linkAuth = null;
      }
    }
  }

  cancelLink(): void {
    if (this.linkAbort) {
      this.linkAbort.abort();
      this.linkAbort = null;
      this.linkAuth = null;
      if (this.device.status === 'vinculando')
        this.device = emptyDevice(this.serverUrl ? 'sin_vincular' : 'sin_configurar');
      this.publish();
    }
  }

  /** Abre el panel para aprobar. Solo el enlace con el código corto y del mismo origen que el servidor. */
  async openVerification(): Promise<void> {
    const auth = this.linkAuth;
    if (!auth || !this.serverUrl) throw new RecorderError('INVALID_STATE');
    if (
      !isSafeExternalUrl(auth.verificationUriComplete, { devMode: this.deps.devMode, requireOrigin: this.serverUrl })
    ) {
      throw new RecorderError('URL_NOT_ALLOWED');
    }
    await this.deps.openExternal(auth.verificationUriComplete);
  }

  private setLinkedDevice(cred: DeviceCredential): void {
    this.device = {
      ...emptyDevice('vinculado'),
      deviceId: cred.deviceId,
      credentialExpiresAt: cred.expiresAt,
      lastHeartbeatAt: this.device.lastHeartbeatAt,
      healthy: this.device.healthy,
    };
  }

  /** Revoca la credencial: en el servidor (best-effort) y siempre localmente. */
  async unlink(): Promise<void> {
    if (this.recording?.activeId) await this.recording.close().catch(() => undefined);
    const cred = this.credential;
    if (cred && this.api) await this.api.revokeDevice(cred.deviceId).catch(() => undefined);
    await this.forgetCredential('Asistente desvinculado.');
  }

  private async forgetCredential(message: string | null): Promise<void> {
    this.stopHeartbeat();
    this.credential = null;
    await this.deps.credentials.clear();
    this.device = { ...emptyDevice(this.serverUrl ? 'sin_vincular' : 'sin_configurar'), message };
    this.publish();
  }

  // ---- Salud del asistente -------------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async heartbeat(): Promise<void> {
    if (!this.api || !this.credential) return;
    try {
      await this.api.deviceHeartbeat({
        clientVersion: this.deps.version,
        activeRecordingId: this.recording?.activeId ?? null,
      });
      this.device = {
        ...this.device,
        healthy: true,
        lastHeartbeatAt: new Date(this.clock.now()).toISOString(),
        message: null,
      };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await this.forgetCredential(new RecorderError('DEVICE_REVOKED').message);
        return;
      }
      this.device = { ...this.device, healthy: false, message: 'Sin conexión con Katalyst; se reintentará.' };
    }
    await this.recording?.enforceStorageStateTtl().catch(() => undefined);
    this.publish();
  }

  // ---- Navegador ----------------------------------------------------------------------------------------

  async refreshBrowser(): Promise<void> {
    try {
      const r = await this.deps.browser.check();
      this.browser = { status: r.installed ? 'instalado' : 'faltante', source: r.source, message: null };
    } catch {
      this.browser = { status: 'error', source: 'ninguno', message: 'No se pudo comprobar Chromium.' };
    }
  }

  async installBrowser(): Promise<void> {
    if (this.browser.status === 'instalando') return;
    this.browser = {
      ...this.browser,
      status: 'instalando',
      message: 'Descargando Chromium (puede tardar unos minutos)…',
    };
    this.publish();
    const ok = await this.deps.browser.install().catch(() => false);
    await this.refreshBrowser();
    if (!ok || this.browser.status !== 'instalado') {
      this.browser = { ...this.browser, status: 'error', message: new RecorderError('BROWSER_INSTALL_FAILED').message };
    }
    this.publish();
  }

  // ---- Grabaciones ---------------------------------------------------------------------------------------

  async listRecordings(scope: 'activas' | 'todas', cursor?: string): Promise<RecordingListView> {
    const api = this.requireApi();
    this.requireLinked();
    const query: { cursor?: string; limit: number } = { limit: 50 };
    if (cursor) query.cursor = cursor;
    const page = await api.listRecordings(query).catch((e: unknown) => this.handleAuthFailure(e));
    const terminal = new Set<string>(TERMINAL_RECORDING_STATUSES);
    const items = [];
    for (const r of page.items) {
      if (scope === 'activas' && terminal.has(r.status)) continue;
      const meta = await this.deps.store.readMeta(r.id);
      items.push({
        id: r.id,
        caseRef: r.caseRef,
        status: r.status,
        tags: r.tags,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        prUrl: r.prUrl,
        hasLocalCode: Boolean(meta?.codeSavedAt),
      });
    }
    return { items, nextCursor: page.hasNext ? page.nextCursor : null };
  }

  async openRecording(id: string): Promise<void> {
    const rec = this.requireLinked();
    this.notice = null;
    await rec.open(id).catch((e: unknown) => this.handleAuthFailure(e));
    this.publish();
  }

  /** `katalyst://grabar?session=<id>`: solo transporta el ID de sesión. */
  async handleDeepLink(raw: string): Promise<void> {
    const link = parseDeepLink(raw);
    if (!link) {
      this.setNotice('error', new RecorderError('DEEP_LINK_INVALID').message);
      return;
    }
    if (!this.serverUrl || !this.credential) {
      this.pendingRecordingId = link.recordingId;
      this.setNotice('info', 'Vincula el asistente con tu cuenta para abrir la grabación solicitada.');
      return;
    }
    if (this.recording?.activeId && this.recording.activeId !== link.recordingId) {
      const phase = this.recording.phase;
      if (phase === 'grabando' || phase === 'login' || phase === 'enviando' || phase === 'iniciando') {
        this.setNotice('error', 'Termina o descarta la grabación en curso antes de abrir otra.');
        return;
      }
    }
    await this.openRecording(link.recordingId).catch((e: unknown) => this.setNotice('error', errorMessage(e)));
  }

  recordingController(): RecordingController {
    return this.requireLinked();
  }

  async openPullRequest(): Promise<void> {
    const view = this.recording?.view();
    if (!view?.prUrl) throw new RecorderError('INVALID_STATE');
    if (!isSafeExternalUrl(view.prUrl, { devMode: this.deps.devMode })) throw new RecorderError('URL_NOT_ALLOWED');
    await this.deps.openExternal(view.prUrl);
  }
}

function emptyDevice(status: DeviceView['status']): DeviceView {
  return {
    status,
    userCode: null,
    verificationUri: null,
    codeExpiresAt: null,
    deviceId: null,
    credentialExpiresAt: null,
    lastHeartbeatAt: null,
    healthy: null,
    message: null,
  };
}

export function errorMessage(e: unknown): string {
  if (isRecorderError(e)) return e.message;
  if (e instanceof ApiError)
    return e.status === 0
      ? new RecorderError('NETWORK_ERROR').message
      : `${new RecorderError('API_ERROR').message} ${e.message}`;
  return new RecorderError('INTERNAL').message;
}
