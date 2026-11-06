/**
 * Reporter de Katalyst para Playwright Test (Reporter API, @playwright/test 1.65.0).
 *
 * - Identidad por anotación `katalyst.stableKey` (+ `katalyst.parameterKey`, default `default`), nunca por título
 *   (RF-CAT-05, ESP §10 regla 9).
 * - `preprocess` (antes de despachar): excluye todo test que no esté en el plan de la asignación, tests sin
 *   anotación y claves duplicadas; informa los faltantes. Verifica flags de Chromium (RNF-CON-03).
 * - `onTestBegin`/`onTestEnd`: eventos por intento (retry incluido) con errores y adjuntos crudos; el ejecutor
 *   persiste el inicio del intento, sanitiza y publica el resultado (RF-EJE-05, RF-EJE-08, RF-RES-01/02).
 * Transporte: IPC con el ejecutor (`process.send`); alternativa JSONL (`KATALYST_REPORTER_EVENTS_FILE`).
 * Sin dependencias en tiempo de ejecución (solo módulos de Node).
 */
import fs from 'node:fs';
import type {
  FullConfig,
  FullProject,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';
import {
  DEFAULT_PARAMETER_KEY,
  PARAMETER_KEY_ANNOTATION,
  REPORTER_ENV,
  STABLE_KEY_ANNOTATION,
  testKey,
  type PlannedTestInfo,
  type ReporterErrorInfo,
  type ReporterMessage,
  type ReporterPlan,
} from './protocol.js';

/** Subconjunto de la API `TestRun` de `preprocess` que usamos (1.65). */
interface TestRunLike {
  exclude(test: TestCase | Suite): void;
}

export type ReporterSink = (msg: ReporterMessage) => void | Promise<void>;

export interface KatalystReporterOptions {
  sink?: ReporterSink;
  plan?: ReporterPlan | null;
}

const MAX_ERROR_CHARS = 16_384;

function clip(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s;
}

function defaultSink(): ReporterSink {
  if (typeof process.send === 'function' && process.connected) {
    return (msg) =>
      new Promise<void>((resolve) => {
        try {
          process.send!(msg, undefined, {}, () => resolve());
        } catch {
          resolve();
        }
      });
  }
  const file = process.env[REPORTER_ENV.eventsFile];
  if (file) return (msg) => fs.appendFileSync(file, `${JSON.stringify(msg)}\n`, { mode: 0o600 });
  return () => undefined;
}

function loadPlan(): ReporterPlan | null {
  const file = process.env[REPORTER_ENV.planFile];
  if (!file) return null;
  const plan = JSON.parse(fs.readFileSync(file, 'utf8')) as ReporterPlan;
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.tests)) throw new Error('Plan de reporter inválido');
  return plan;
}

export function annotationValue(test: Pick<TestCase, 'annotations'>, type: string): string | undefined {
  return test.annotations.find((a) => a.type === type)?.description?.trim() || undefined;
}

/** Clave `(stableKey, parameterKey)` del test o `null` si no declara `katalyst.stableKey`. */
export function keyOfTest(test: Pick<TestCase, 'annotations'>): string | null {
  const sk = annotationValue(test, STABLE_KEY_ANNOTATION);
  if (!sk) return null;
  return testKey(sk, annotationValue(test, PARAMETER_KEY_ANNOTATION) ?? DEFAULT_PARAMETER_KEY);
}

function errorInfo(e: TestError): ReporterErrorInfo {
  const out: ReporterErrorInfo = {};
  const message = clip(e.message);
  if (message !== undefined) out.message = message;
  const stack = clip(e.stack);
  if (stack !== undefined) out.stack = stack;
  const value = clip(e.value);
  if (value !== undefined) out.value = value;
  return out;
}

export default class KatalystReporter implements Reporter {
  private readonly sink: ReporterSink;
  private readonly plan: ReporterPlan | null;
  private readonly setupProjects = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: KatalystReporterOptions = {}) {
    this.sink = options.sink ?? defaultSink();
    this.plan = options.plan === undefined ? loadPlan() : options.plan;
  }

  printsToStdio(): boolean {
    return false;
  }

  private emit(msg: ReporterMessage): void {
    this.pending = this.pending.then(() => this.sink(msg)).catch(() => undefined);
  }

  private computeSetupProjects(config: FullConfig): void {
    this.setupProjects.clear();
    for (const p of config.projects) {
      for (const dep of p.dependencies ?? []) this.setupProjects.add(dep);
      if (p.teardown) this.setupProjects.add(p.teardown);
    }
  }

  private projectOf(test: TestCase): FullProject | undefined {
    return test.parent.project();
  }

  private isSetup(test: TestCase): boolean {
    const name = this.projectOf(test)?.name ?? '';
    return this.setupProjects.has(name);
  }

  async preprocess(params: { config: FullConfig; suite: Suite; testRun: TestRunLike }): Promise<void> {
    this.computeSetupProjects(params.config);
    const plan = this.plan;
    if (!plan) return;
    const wanted = new Set(plan.tests.map((t) => testKey(t.stableKey, t.parameterKey)));
    const byKey = new Map<string, TestCase[]>();
    const unmapped: Array<{ title: string; file: string; projectName: string }> = [];
    const usedProjects = new Map<string, FullProject>();

    for (const test of params.suite.allTests()) {
      if (this.isSetup(test)) continue; // dependencias: de solo lectura en preprocess
      const project = this.projectOf(test);
      const projectName = project?.name ?? '';
      if (plan.projectName && projectName !== plan.projectName) {
        params.testRun.exclude(test);
        continue;
      }
      const key = keyOfTest(test);
      if (!key) {
        unmapped.push({ title: test.title, file: test.location.file, projectName });
        params.testRun.exclude(test);
        continue;
      }
      if (!wanted.has(key)) {
        params.testRun.exclude(test);
        continue;
      }
      const list = byKey.get(key) ?? [];
      list.push(test);
      byKey.set(key, list);
      if (project) usedProjects.set(projectName, project);
    }

    const found: PlannedTestInfo[] = [];
    const duplicates: string[] = [];
    for (const [key, tests] of byKey) {
      if (tests.length > 1) {
        duplicates.push(key);
        for (const t of tests) params.testRun.exclude(t);
        continue;
      }
      const t = tests[0]!;
      found.push({
        key,
        testId: t.id,
        title: t.title,
        file: t.location.file,
        line: t.location.line,
        projectName: this.projectOf(t)?.name ?? '',
        retries: t.retries,
      });
    }
    const foundKeys = new Set(found.map((f) => f.key));
    const missing = [...wanted].filter((k) => !foundKeys.has(k) && !duplicates.includes(k));

    const missingChromiumFlags = new Set<string>();
    for (const project of usedProjects.values()) {
      const args = (project.use as { launchOptions?: { args?: string[] } }).launchOptions?.args ?? [];
      for (const flag of plan.requiredChromiumFlags) if (!args.includes(flag)) missingChromiumFlags.add(flag);
    }
    this.emit({ type: 'plan', found, missing, unmapped, duplicates, missingChromiumFlags: [...missingChromiumFlags] });
    await this.pending;
  }

  onBegin(config: FullConfig): void {
    if (this.setupProjects.size === 0) this.computeSetupProjects(config);
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.emit({
      type: 'testBegin',
      key: keyOfTest(test),
      testId: test.id,
      title: test.title,
      projectName: this.projectOf(test)?.name ?? '',
      isSetup: this.isSetup(test),
      retry: result.retry,
      startTime: result.startTime.toISOString(),
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const failedLike = result.status !== test.expectedStatus && result.status !== 'skipped' && result.status !== 'interrupted';
    const annotations = [...test.annotations, ...((result as { annotations?: TestCase['annotations'] }).annotations ?? [])]
      .filter((a, i, all) => all.findIndex((b) => b.type === a.type && b.description === a.description) === i)
      .map((a) => (a.description === undefined ? { type: a.type } : { type: a.type, description: a.description }));
    this.emit({
      type: 'testEnd',
      key: keyOfTest(test),
      testId: test.id,
      title: test.title,
      projectName: this.projectOf(test)?.name ?? '',
      isSetup: this.isSetup(test),
      retry: result.retry,
      retries: test.retries,
      status: result.status,
      expectedStatus: test.expectedStatus,
      startTime: result.startTime.toISOString(),
      duration: Math.max(0, Math.round(result.duration)),
      timeoutMs: test.timeout,
      errors: result.errors.map(errorInfo),
      annotations,
      attachments: result.attachments
        .filter((a) => typeof a.path === 'string')
        .map((a) => ({ name: a.name, contentType: a.contentType, path: a.path! })),
      willRetry: failedLike && result.retry < test.retries,
    });
  }

  onError(error: TestError): void {
    const info = errorInfo(error);
    this.emit({ type: 'error', message: info.message ?? info.value ?? 'error', ...(info.stack ? { stack: info.stack } : {}) });
  }

  async onEnd(result: FullResult): Promise<void> {
    this.emit({ type: 'end', status: result.status });
    await this.pending;
  }

  async onExit(): Promise<void> {
    await this.pending;
  }
}
