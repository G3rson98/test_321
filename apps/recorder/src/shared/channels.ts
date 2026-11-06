/**
 * Canales IPC permitidos entre renderer y main (allowlist). El preload solo importa este archivo (sin dependencias)
 * para mantenerse mínimo; los esquemas Zod de cada mensaje viven en `ipc.ts` y se validan en main.
 * RF-GRB-01, RF-GRB-06.
 */
export const IPC_COMMANDS = {
  getState: 'katalyst:get-state',
  setServerUrl: 'katalyst:config:set-server-url',
  startLink: 'katalyst:device:start-link',
  cancelLink: 'katalyst:device:cancel-link',
  openVerification: 'katalyst:device:open-verification',
  unlink: 'katalyst:device:unlink',
  installBrowser: 'katalyst:browser:install',
  listRecordings: 'katalyst:recordings:list',
  openRecording: 'katalyst:recording:open',
  startLogin: 'katalyst:recording:start-login',
  startCapture: 'katalyst:recording:start-capture',
  stopCapture: 'katalyst:recording:stop',
  rerecord: 'katalyst:recording:rerecord',
  addVerification: 'katalyst:recording:add-verification',
  validateDraft: 'katalyst:recording:validate',
  maskSensitive: 'katalyst:recording:mask-sensitive',
  submit: 'katalyst:recording:submit',
  discard: 'katalyst:recording:discard',
  closeRecording: 'katalyst:recording:close',
  openPullRequest: 'katalyst:recording:open-pr',
} as const;

export type IpcCommand = (typeof IPC_COMMANDS)[keyof typeof IPC_COMMANDS];

/** Evento main → renderer con la instantánea completa del estado (validada antes de enviarse). */
export const IPC_EVENTS = {
  stateChanged: 'katalyst:state-changed',
} as const;

export const ALL_COMMANDS: readonly IpcCommand[] = Object.values(IPC_COMMANDS);
