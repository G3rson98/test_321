/**
 * Orquestación de una sesión de grabación en el equipo del QA (ESP §13.6, RF-GRB-01/02/06):
 *   abrir (GET /recordings/{id}) → bloquear producción → login interactivo SIN captura (Chromium propio; MFA local)
 *   → storageState temporal 0600 → codegen con --load-storage → pasos/verificaciones en vivo → detener/descartar/
 *   regrabar → validación local → POST /recordings/{id}/complete → URL del PR → borrado local.
 * Las credenciales del worker nunca se descargan; el storageState nunca sale del equipo ni llega al renderer.
 * Módulo sin dependencias de Electron (navegador de login y codegen inyectados) para probarlo con dobles.
 */
import { promises as fs } from 'node:fs';
import { TERMINAL_RECORDING_STATUSES, type RecordingStatus } from '@katalyst/shared/enums';
import type { RecordingView, StepView, IssueView } from '../../shared/ipc.js';
import { ApiError, type KatalystApiClient, type RecordingDetail } from './api-client.js';
import { prepareCodeForSubmit, buildTestTitle } from './code-transform.js';
import type { CodegenExit } from './codegen-runner.js';
import {
  assertRecordableEnvironment,
  assertUrlNotProduction,
  resolveRecordingEnvironment,
  type RecordingEnvironment,
} from './environment-guard.js';
import { RecorderError, isRecorderError } from './errors.js';
import type { SessionStore } from './session-store.js';
import { STORAGE_STATE_TTL_MS } from './session-store.js';
import { parseCodegenOutput, toApiSteps, type ParseResult } from './step-parser.js';
import { maskSensitiveValues, validateBeforeSubmit, type ValidationReport } from './validation.js';
import { sanitizeErrorMessage } from '@katalyst/shared/sanitize';

export interface LoginBrowser {
  open(url: string | null): Promise<void>;
  /** Estado autenticado del contexto (cookies/localStorage). SECRETO: solo se escribe en el directorio temporal. */
  storageState(): Promise<unknown>;
  close(): Promise<void>;
  onClosed(cb: () => void): void;
}

export interface CodegenHandle {
  start(args: { storageStatePath: string | null; url: string | null }): void;
  stop(): Promise<CodegenExit>;
  readonly exited: Promise<CodegenExit>;
  readonly running: boolean;
}

export type RecorderApi = Pick<
  KatalystApiClient,
  'getRecording' | 'listEnvironments' | 'updateRecordingStatus' | 'completeRecording' | 'cancelRecording'
>;

export interface RecordingControllerDeps {
  api: RecorderApi;
  store: SessionStore;
  createLoginBrowser: () => LoginBrowser;
  createCodegen: (outputFile: string, onCode: (code: string) => void) => CodegenHandle;
  /** `true` si Chromium está instalado (incluido o descargado). */
  browserReady: () => Promise<boolean>;
  devMode: boolean;
  now?: () => number;
  onChange: () => void;
  /** Intervalo mínimo entre envíos de pasos a la API mientras se graba. */
  stepsThrottleMs?: number;
}

export interface Draft {
  title: string;
  tags: string[];
  classification: 'lectura' | 'escritura' | 'sin_clasificar';
}

type Phase = RecordingView['phase'];

interface Session {
  detail: RecordingDetail;
  env: RecordingEnvironment | null;
  phase: Phase;
  message: string | null;
  code: string | null;
  parse: ParseResult | null;
  /** Totales de verificaciones a alcanzar por cada "Agregar verificación" pedido (pendiente hasta alcanzarlo). */
  requested: number[];
  verificationGuide: boolean;
  hasStorageState: boolean;
  validation: ValidationReport | null;
  prUrl: string | null;
  rejectionReasons: RecordingView['rejectionReasons'];
  serverStatus: RecordingStatus | null;
  login: LoginBrowser | null;
  codegen: CodegenHandle | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  lastStepsSentAt: number;
  stepsTimer: ReturnType<typeof setTimeout> | null;
  lastStepsSignature: string;
}

const TERMINAL = new Set<string>(TERMINAL_RECORDING_STATUSES);

export class RecordingController {
  private s: Session | null = null;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RecordingControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get activeId(): string | null {
    return this.s?.detail.id ?? null;
  }

  /** Serializa comandos del usuario para evitar carreras (doble clic). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private emit(): void {
    this.deps.onChange();
  }

  private requireSession(): Session {
    if (!this.s) throw new RecorderError('RECORDING_NOT_OPEN');
    return this.s;
  }

  private requirePhase(...phases: Phase[]): Session {
    const s = this.requireSession();
    if (!phases.includes(s.phase)) throw new RecorderError('INVALID_STATE');
    return s;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Abrir
  // ---------------------------------------------------------------------------------------------------------

  open(id: string): Promise<void> {
    return this.run(async () => {
      if (this.s && this.s.detail.id !== id) await this.closeInternal();
      if (this.s?.detail.id === id && this.s.phase !== 'error') return;
      const detail = await this.deps.api.getRecording(id);
      const s: Session = {
        detail,
        env: null,
        phase: 'cargando',
        message: null,
        code: null,
        parse: null,
        requested: [],
        verificationGuide: false,
        hasStorageState: false,
        validation: null,
        prUrl: detail.prUrl,
        rejectionReasons: detail.rejectionReasons,
        serverStatus: detail.status,
        login: null,
        codegen: null,
        expiryTimer: null,
        lastStepsSentAt: 0,
        stepsTimer: null,
        lastStepsSignature: '',
      };
      this.s = s;
      this.emit();

      if (TERMINAL.has(detail.status)) {
        s.phase =
          detail.status === 'pr_abierto'
            ? 'enviada'
            : detail.status === 'rechazada'
              ? 'rechazada'
              : detail.status === 'cancelada'
                ? 'cancelada'
                : 'vencida';
        await this.deps.store.remove(id).catch(() => undefined);
        this.emit();
        return;
      }
      if (Date.parse(detail.expiresAt) <= this.now()) {
        s.phase = 'vencida';
        s.message = new RecorderError('RECORDING_EXPIRED').message;
        await this.deps.store.remove(id).catch(() => undefined);
        this.emit();
        return;
      }
      // La API incluye `environment` en el detalle (D-028); `GET /environments` es solo respaldo. Sin ninguno de los
      // dos se bloquea (falla cerrado).
      const summaries = detail.environment ? null : await this.deps.api.listEnvironments().catch(() => null);
      try {
        s.env = assertRecordableEnvironment(resolveRecordingEnvironment(detail, summaries), {
          devMode: this.deps.devMode,
        });
      } catch (e) {
        s.phase = 'bloqueada';
        s.message = isRecorderError(e) ? e.message : new RecorderError('ENVIRONMENT_UNKNOWN').message;
        this.emit();
        return;
      }
      await this.deps.store.open(id, detail.expiresAt);
      s.hasStorageState = (await this.deps.store.validStorageState(id)) !== null;
      const existing = await this.deps.store.readCode(id);
      if (existing && existing.trim()) {
        this.applyCode(s, existing);
        s.phase = 'detenida';
        s.message = 'Se recuperó una grabación sin enviar de este equipo.';
      } else {
        s.phase = 'lista';
      }
      this.scheduleExpiry(s);
      if (detail.status === 'creada') {
        await this.deps.api.updateRecordingStatus(id, { status: 'vinculada' }).catch(() => undefined);
        s.serverStatus = 'vinculada';
      }
      this.emit();
    });
  }

  private scheduleExpiry(s: Session): void {
    if (s.expiryTimer) clearTimeout(s.expiryTimer);
    const ms = Math.max(0, Date.parse(s.detail.expiresAt) - this.now());
    // setTimeout admite hasta ~24,8 días; las grabaciones vencen a las 2 h.
    s.expiryTimer = setTimeout(() => void this.expire(), Math.min(ms, 2 ** 31 - 1));
    (s.expiryTimer as { unref?: () => void }).unref?.();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Login interactivo (captura en pausa)
  // ---------------------------------------------------------------------------------------------------------

  startLogin(): Promise<void> {
    return this.run(async () => {
      const s = this.requirePhase('lista');
      if (!(await this.deps.browserReady())) throw new RecorderError('BROWSER_MISSING');
      const url = s.env?.appUrl ?? null;
      if (url) assertUrlNotProduction(url);
      const login = this.deps.createLoginBrowser();
      try {
        await login.open(url);
      } catch {
        await login.close().catch(() => undefined);
        throw new RecorderError('BROWSER_LAUNCH_FAILED');
      }
      s.login = login;
      s.phase = 'login';
      s.message = null;
      login.onClosed(() => {
        if (this.s === s && s.phase === 'login') {
          s.login = null;
          s.phase = 'lista';
          s.message = 'Cerraste el navegador antes de comenzar a grabar. Puedes volver a iniciar sesión.';
          this.emit();
        }
      });
      this.emit();
    });
  }

  /** Comienza la captura: guarda el estado del login (si lo hubo) y lanza codegen con `--load-storage`. */
  startCapture(opts: { skipLogin: boolean }): Promise<void> {
    return this.run(async () => {
      const s = this.requirePhase('lista', 'login');
      if (!(await this.deps.browserReady())) throw new RecorderError('BROWSER_MISSING');
      if (s.phase === 'login') {
        const login = s.login;
        s.login = null;
        try {
          const state = login ? await login.storageState() : null;
          if (state) {
            await this.deps.store.writeStorageState(s.detail.id, state);
            s.hasStorageState = true;
          }
        } finally {
          await login?.close().catch(() => undefined);
        }
      } else if (!opts.skipLogin && !s.hasStorageState) {
        throw new RecorderError(
          'INVALID_STATE',
          'Primero inicia sesión en el navegador o elige grabar sin iniciar sesión.',
        );
      }
      await this.launchCodegen(s);
    });
  }

  private async launchCodegen(s: Session): Promise<void> {
    const id = s.detail.id;
    const paths = this.deps.store.paths(id);
    await this.deps.store.deleteCode(id);
    s.code = null;
    s.parse = null;
    s.validation = null;
    s.requested = [];
    s.verificationGuide = false;
    s.message = null;
    s.phase = 'iniciando';
    this.emit();
    const storageStatePath = await this.deps.store.validStorageState(id);
    s.hasStorageState = storageStatePath !== null;
    const url = s.env?.appUrl ?? null;
    if (url) assertUrlNotProduction(url);
    const codegen = this.deps.createCodegen(paths.codePath, (code) => this.onCode(s, code));
    try {
      codegen.start({ storageStatePath, url });
    } catch {
      s.phase = 'error';
      s.message = new RecorderError('BROWSER_LAUNCH_FAILED').message;
      this.emit();
      return;
    }
    s.codegen = codegen;
    s.phase = 'grabando';
    this.emit();
    void codegen.exited.then((exit) => this.onCodegenExit(s, codegen, exit));
    await this.deps.api.updateRecordingStatus(id, { status: 'grabando' }).then(
      () => {
        s.serverStatus = 'grabando';
      },
      () => undefined,
    );
  }

  private applyCode(s: Session, code: string): void {
    s.code = code;
    s.parse = parseCodegenOutput(code);
    const count = s.parse.verificationCount;
    // Cada pedido guarda el total de verificaciones que debe alcanzarse; se cumple al aparecer una nueva.
    s.requested = s.requested.filter((target) => count < target);
    if (s.requested.length === 0) s.verificationGuide = false;
    s.validation = null;
  }

  private onCode(s: Session, code: string): void {
    if (this.s !== s) return;
    this.applyCode(s, code);
    this.emit();
    this.scheduleStepsUpdate(s);
  }

  private scheduleStepsUpdate(s: Session, immediate = false): void {
    if (!s.parse) return;
    const throttle = this.deps.stepsThrottleMs ?? 10_000;
    const send = () => {
      s.stepsTimer = null;
      if (!s.parse || this.s !== s) return;
      const steps = toApiSteps(s.parse);
      const sig = JSON.stringify(steps);
      if (sig === s.lastStepsSignature) return;
      s.lastStepsSignature = sig;
      s.lastStepsSentAt = this.now();
      void this.deps.api.updateRecordingStatus(s.detail.id, { status: 'grabando', steps }).catch(() => undefined);
    };
    if (immediate) {
      if (s.stepsTimer) clearTimeout(s.stepsTimer);
      send();
      return;
    }
    if (s.stepsTimer) return;
    const wait = Math.max(0, s.lastStepsSentAt + throttle - this.now());
    s.stepsTimer = setTimeout(send, wait);
    (s.stepsTimer as { unref?: () => void }).unref?.();
  }

  private async onCodegenExit(s: Session, codegen: CodegenHandle, exit: CodegenExit): Promise<void> {
    if (this.s !== s || s.codegen !== codegen) return;
    s.codegen = null;
    if (s.phase !== 'grabando' && s.phase !== 'iniciando') return;
    const code = await this.deps.store.readCode(s.detail.id);
    if (code && code.trim()) {
      this.applyCode(s, code);
      await this.deps.store.markCodeSaved(s.detail.id).catch(() => undefined);
      s.phase = 'detenida';
      s.message = exit.stoppedByUser
        ? null
        : 'Cerraste la grabadora. Revisa los pasos y envía el PR o vuelve a grabar.';
      this.scheduleStepsUpdate(s, true);
    } else {
      s.phase = exit.stoppedByUser || exit.code === 0 ? 'detenida' : 'error';
      s.message =
        exit.stoppedByUser || exit.code === 0
          ? new RecorderError('NO_CODE').message
          : new RecorderError('CODEGEN_FAILED').message;
    }
    this.emit();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Detener / regrabar / verificación
  // ---------------------------------------------------------------------------------------------------------

  stop(): Promise<void> {
    return this.run(async () => {
      const s = this.requirePhase('grabando', 'iniciando');
      const codegen = s.codegen;
      if (codegen) await codegen.stop();
      // onCodegenExit completa la transición a `detenida`.
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  rerecord(): Promise<void> {
    return this.run(async () => {
      const s = this.requirePhase('detenida', 'error', 'rechazada');
      if (s.phase === 'rechazada' && s.serverStatus === 'rechazada') throw new RecorderError('RECORDING_TERMINAL');
      if (!(await this.deps.browserReady())) throw new RecorderError('BROWSER_MISSING');
      const state = await this.deps.store.validStorageState(s.detail.id);
      if (state) {
        await this.launchCodegen(s);
      } else {
        await this.deps.store.deleteCode(s.detail.id);
        s.code = null;
        s.parse = null;
        s.validation = null;
        s.hasStorageState = false;
        s.phase = 'lista';
        s.message = 'La sesión de inicio expiró o no existe: vuelve a iniciar sesión para grabar.';
        this.emit();
      }
    });
  }

  addVerification(): Promise<void> {
    return this.run(async () => {
      const s = this.requirePhase('grabando');
      const current = s.parse?.verificationCount ?? 0;
      const lastTarget = s.requested[s.requested.length - 1] ?? 0;
      s.requested.push(Math.max(current, lastTarget) + 1);
      s.verificationGuide = true;
      this.emit();
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Validación y envío
  // ---------------------------------------------------------------------------------------------------------

  private prepare(s: Session, draft: Draft): { code: string; parse: ParseResult; report: ValidationReport } {
    if (!s.code || !s.code.trim()) throw new RecorderError('NO_CODE');
    const code = prepareCodeForSubmit(s.code, {
      caseRef: s.detail.caseRef,
      title: draft.title,
      tags: draft.tags,
      appUrl: s.env?.appUrl ?? null,
    });
    const parse = parseCodegenOutput(code);
    const report = validateBeforeSubmit(code, { parse, extraPendingVerifications: s.requested.length });
    return { code, parse, report };
  }

  validate(draft: Draft): Promise<ValidationReport> {
    return this.run(async () => {
      const s = this.requirePhase('detenida');
      const { report } = this.prepare(s, draft);
      s.validation = report;
      this.emit();
      return report;
    });
  }

  maskSensitive(): Promise<number> {
    return this.run(async () => {
      const s = this.requirePhase('detenida');
      if (!s.code) throw new RecorderError('NO_CODE');
      const { code, masked } = maskSensitiveValues(s.code);
      if (masked > 0) {
        const paths = this.deps.store.paths(s.detail.id);
        await fs.writeFile(paths.codePath, code, { mode: 0o600 });
        this.applyCode(s, code);
      }
      this.emit();
      return masked;
    });
  }

  submit(draft: Draft, acknowledgeWarnings: boolean): Promise<void> {
    return this.run(async () => {
      const s = this.requirePhase('detenida');
      const { code, parse, report } = this.prepare(s, draft);
      s.validation = report;
      if (!report.ok) {
        this.emit();
        throw new RecorderError('VALIDATION_BLOCKED');
      }
      if (report.issues.length > 0 && !acknowledgeWarnings) {
        this.emit();
        throw new RecorderError('WARNINGS_NOT_ACKNOWLEDGED');
      }
      s.phase = 'enviando';
      s.message = null;
      this.emit();
      try {
        const res = await this.deps.api.completeRecording(s.detail.id, {
          code,
          classification: draft.classification,
          title: buildTestTitle(s.detail.caseRef, draft.title, draft.tags),
          tags: draft.tags,
          steps: toApiSteps(parse),
          pendingVerifications: parse.pendingVerifications + s.requested.length,
        });
        s.serverStatus = res.status;
        s.prUrl = res.prUrl;
        s.rejectionReasons = res.rejectionReasons;
        if (res.status === 'rechazada') {
          s.phase = 'rechazada';
          s.message = 'Katalyst rechazó la grabación. Revisa los motivos.';
        } else {
          s.phase = 'enviada';
          s.message = res.prUrl ? null : 'Katalyst está validando la grabación; el pull request aparecerá en el panel.';
        }
        // Envío terminado: se borra el código local y el storageState (ESP §7, §13.6).
        await this.cleanupLocal(s);
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.code === 'RECORDING_EXPIRED') {
            s.phase = 'vencida';
            s.message = new RecorderError('RECORDING_EXPIRED').message;
            await this.cleanupLocal(s);
          } else if (e.code === 'SECRET_DETECTED' || e.code === 'RECORDING_REJECTED') {
            // El backend rechazó en su sandbox y dejó la sesión `rechazada` con motivos (sin valores).
            const fresh = await this.deps.api.getRecording(s.detail.id).catch(() => null);
            s.serverStatus = fresh?.status ?? 'rechazada';
            s.rejectionReasons = fresh?.rejectionReasons.length
              ? fresh.rejectionReasons
              : rejectionFromDetails(e.details);
            s.phase = s.serverStatus === 'rechazada' ? 'rechazada' : 'detenida';
            s.message =
              e.code === 'SECRET_DETECTED'
                ? 'Katalyst detectó datos sensibles en la grabación y la rechazó. Crea una nueva grabación desde el panel.'
                : 'Katalyst rechazó la grabación. Revisa los motivos.';
            if (s.phase === 'rechazada') await this.cleanupLocal(s);
          } else {
            s.phase = 'detenida';
            s.message =
              `${new RecorderError(e.status === 0 ? 'NETWORK_ERROR' : 'API_ERROR').message} ${sanitizeErrorMessage(e.message, 300)}`.trim();
            s.rejectionReasons = rejectionFromDetails(e.details);
          }
          this.emit();
          return;
        }
        s.phase = 'detenida';
        this.emit();
        throw e;
      }
      this.emit();
    });
  }

  private async cleanupLocal(s: Session): Promise<void> {
    if (s.expiryTimer) clearTimeout(s.expiryTimer);
    if (s.stepsTimer) clearTimeout(s.stepsTimer);
    s.expiryTimer = null;
    s.stepsTimer = null;
    await this.deps.store.remove(s.detail.id).catch(() => undefined);
    s.hasStorageState = false;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Descartar / cerrar / vencer
  // ---------------------------------------------------------------------------------------------------------

  discard(reason?: string): Promise<void> {
    return this.run(async () => {
      const s = this.requireSession();
      if (['enviando'].includes(s.phase)) throw new RecorderError('INVALID_STATE');
      await this.stopProcesses(s);
      if (s.serverStatus && !TERMINAL.has(s.serverStatus)) {
        try {
          await this.deps.api.cancelRecording(s.detail.id, reason);
          s.serverStatus = 'cancelada';
        } catch (e) {
          if (!(e instanceof ApiError && (e.status === 409 || e.status === 404))) {
            await this.cleanupLocal(s);
            s.phase = 'cancelada';
            s.message = 'Se borró la grabación de este equipo, pero no se pudo avisar a Katalyst; vencerá sola.';
            this.emit();
            return;
          }
        }
      }
      await this.cleanupLocal(s);
      s.phase = 'cancelada';
      s.message = null;
      s.code = null;
      s.parse = null;
      this.emit();
    });
  }

  private async stopProcesses(s: Session): Promise<void> {
    const codegen = s.codegen;
    s.codegen = null;
    if (codegen?.running) await codegen.stop().catch(() => undefined);
    const login = s.login;
    s.login = null;
    await login?.close().catch(() => undefined);
  }

  /** Cierra la sesión local: detiene procesos y borra el storageState; el código sin enviar se conserva ≤ 24 h. */
  close(): Promise<void> {
    return this.run(() => this.closeInternal());
  }

  private async closeInternal(): Promise<void> {
    const s = this.s;
    if (!s) return;
    if (s.phase === 'enviando') throw new RecorderError('INVALID_STATE');
    this.s = null;
    if (s.expiryTimer) clearTimeout(s.expiryTimer);
    if (s.stepsTimer) clearTimeout(s.stepsTimer);
    await this.stopProcesses(s);
    await this.deps.store.deleteStorageState(s.detail.id).catch(() => undefined);
    if (['enviada', 'rechazada', 'cancelada', 'vencida', 'bloqueada'].includes(s.phase)) {
      await this.deps.store.remove(s.detail.id).catch(() => undefined);
    } else if (s.code) {
      await this.deps.store.markCodeSaved(s.detail.id).catch(() => undefined);
    }
    this.emit();
  }

  /** Vencimiento de la sesión (2 h): se detienen los procesos y se borra todo lo local. */
  expire(): Promise<void> {
    return this.run(async () => {
      const s = this.s;
      if (!s || ['enviada', 'rechazada', 'cancelada', 'vencida'].includes(s.phase)) return;
      await this.stopProcesses(s);
      await this.cleanupLocal(s);
      s.phase = 'vencida';
      s.message = new RecorderError('RECORDING_EXPIRED').message;
      s.code = null;
      s.parse = null;
      this.emit();
    });
  }

  /** El storageState también vence a las 2 h aunque la grabación siga abierta. */
  async enforceStorageStateTtl(): Promise<void> {
    const s = this.s;
    if (!s) return;
    const meta = await this.deps.store.readMeta(s.detail.id);
    if (meta?.storageStateCreatedAt && this.now() - Date.parse(meta.storageStateCreatedAt) >= STORAGE_STATE_TTL_MS) {
      await this.deps.store.deleteStorageState(s.detail.id);
      s.hasStorageState = false;
      this.emit();
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Vista
  // ---------------------------------------------------------------------------------------------------------

  view(): RecordingView | null {
    const s = this.s;
    if (!s) return null;
    const steps: StepView[] = (s.parse?.steps ?? []).map((x) => ({
      index: x.index,
      line: x.line,
      kind: x.kind,
      description: x.description,
    }));
    const warnings: IssueView[] = (s.parse?.warnings ?? []).map((w) => ({
      severity: 'advertencia',
      code: w.code,
      message: w.message,
      line: w.line,
    }));
    if (s.requested.length > 0) {
      warnings.unshift({
        severity: 'advertencia',
        code: 'REQUESTED_VERIFICATION_PENDING',
        message:
          'Verificación pedida: en la barra de la grabadora elige "Assert visibility", "Assert text" o "Assert value" y haz clic en el elemento.',
        line: null,
      });
    }
    return {
      id: s.detail.id,
      caseRef: s.detail.caseRef,
      serverStatus: s.serverStatus,
      phase: s.phase,
      environmentName: s.env?.name ?? null,
      appUrl: s.env?.appUrl ?? null,
      expiresAt: s.detail.expiresAt,
      tags: s.detail.tags,
      steps: steps.slice(0, 500),
      warnings: warnings.slice(0, 200),
      pendingVerifications: (s.parse?.pendingVerifications ?? 0) + s.requested.length,
      verificationGuide: s.verificationGuide,
      hasStorageState: s.hasStorageState,
      codePreview: s.code ? maskSensitiveValues(s.code).code.slice(0, 200_000) : null,
      validation: s.validation,
      prUrl: s.prUrl,
      rejectionReasons: s.rejectionReasons,
      message: s.message,
    };
  }

  /** Para pruebas y heartbeat. */
  get phase(): Phase | null {
    return this.s?.phase ?? null;
  }

  get caseRef(): string | null {
    return this.s?.detail.caseRef ?? null;
  }
}

function rejectionFromDetails(details: unknown): RecordingView['rejectionReasons'] {
  // Formas admitidas: `[{code,message,line}]` o `{ reasons: ['CODIGO', …] }` (API-C, D-028).
  if (details && typeof details === 'object' && Array.isArray((details as { reasons?: unknown }).reasons)) {
    return (details as { reasons: unknown[] }).reasons
      .filter((r): r is string => typeof r === 'string')
      .slice(0, 50)
      .map((code) => ({ code: code.slice(0, 64), message: 'Motivo informado por Katalyst', line: null }));
  }
  if (!Array.isArray(details)) return [];
  return details
    .filter((d): d is { code?: unknown; message?: unknown; line?: unknown } => typeof d === 'object' && d !== null)
    .slice(0, 50)
    .map((d) => ({
      code: typeof d.code === 'string' ? d.code.slice(0, 64) : 'RECHAZO',
      message: typeof d.message === 'string' ? sanitizeErrorMessage(d.message, 500) : 'Motivo no especificado',
      line: typeof d.line === 'number' && Number.isInteger(d.line) ? d.line : null,
    }));
}
