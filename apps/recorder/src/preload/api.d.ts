/** Tipos de la API expuesta por el preload en `window.katalyst` (sin código: solo tipos). */
import type { AppState, IpcResult, RecordingDraft, RecordingListView, ValidationView } from '../shared/ipc.js';

export interface KatalystBridge {
  getState(): Promise<IpcResult<AppState>>;
  setServerUrl(serverUrl: string): Promise<IpcResult<null>>;
  startLink(): Promise<IpcResult<null>>;
  cancelLink(): Promise<IpcResult<null>>;
  openVerification(): Promise<IpcResult<null>>;
  unlink(): Promise<IpcResult<null>>;
  installBrowser(): Promise<IpcResult<null>>;
  listRecordings(scope: 'activas' | 'todas', cursor?: string): Promise<IpcResult<RecordingListView>>;
  openRecording(id: string): Promise<IpcResult<null>>;
  startLogin(): Promise<IpcResult<null>>;
  startCapture(skipLogin: boolean): Promise<IpcResult<null>>;
  stopCapture(): Promise<IpcResult<null>>;
  rerecord(): Promise<IpcResult<null>>;
  addVerification(): Promise<IpcResult<null>>;
  validateDraft(draft: RecordingDraft): Promise<IpcResult<ValidationView>>;
  maskSensitive(): Promise<IpcResult<number>>;
  submit(draft: RecordingDraft, acknowledgeWarnings: boolean): Promise<IpcResult<null>>;
  discard(reason?: string): Promise<IpcResult<null>>;
  closeRecording(): Promise<IpcResult<null>>;
  openPullRequest(): Promise<IpcResult<null>>;
  onState(cb: (state: AppState) => void): () => void;
}

declare global {
  interface Window {
    katalyst: KatalystBridge;
  }
}
