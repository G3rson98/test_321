/**
 * Preload mínimo (sandbox: true, CommonJS): expone una API tipada y cerrada vía contextBridge. No expone
 * `ipcRenderer` ni canales arbitrarios; cada método invoca un canal de la allowlist y main valida el mensaje con
 * Zod. Nunca transporta la credencial del dispositivo ni el storageState. RNF-SEG-01, ESP §4.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_COMMANDS as C, IPC_EVENTS } from '../shared/channels.js';
import type { KatalystBridge } from './api.js';

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

const bridge: KatalystBridge = {
  getState: () => invoke(C.getState),
  setServerUrl: (serverUrl) => invoke(C.setServerUrl, { serverUrl }),
  startLink: () => invoke(C.startLink),
  cancelLink: () => invoke(C.cancelLink),
  openVerification: () => invoke(C.openVerification),
  unlink: () => invoke(C.unlink),
  installBrowser: () => invoke(C.installBrowser),
  listRecordings: (scope, cursor) => invoke(C.listRecordings, cursor ? { scope, cursor } : { scope }),
  openRecording: (id) => invoke(C.openRecording, { id }),
  startLogin: () => invoke(C.startLogin),
  startCapture: (skipLogin) => invoke(C.startCapture, { skipLogin }),
  stopCapture: () => invoke(C.stopCapture),
  rerecord: () => invoke(C.rerecord),
  addVerification: () => invoke(C.addVerification),
  validateDraft: (draft) => invoke(C.validateDraft, { draft }),
  maskSensitive: () => invoke(C.maskSensitive),
  submit: (draft, acknowledgeWarnings) => invoke(C.submit, { draft, acknowledgeWarnings }),
  discard: (reason) => invoke(C.discard, reason ? { reason } : {}),
  closeRecording: () => invoke(C.closeRecording),
  openPullRequest: () => invoke(C.openPullRequest),
  onState: (cb) => {
    const listener = (_e: IpcRendererEvent, state: unknown) => cb(state as Parameters<typeof cb>[0]);
    ipcRenderer.on(IPC_EVENTS.stateChanged, listener);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.stateChanged, listener);
    };
  },
};

contextBridge.exposeInMainWorld('katalyst', Object.freeze(bridge));
