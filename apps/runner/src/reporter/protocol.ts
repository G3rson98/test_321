/**
 * Protocolo entre el reporter de Playwright (proceso principal de `playwright test`) y el ejecutor de shard.
 * El reporter NO habla con la API ni conoce el leaseToken: emite eventos crudos por IPC (`process.send`) y el
 * ejecutor sanitiza, clasifica y llama a la API. Sin dependencias (lo carga Playwright desde dist/ o src/).
 * RF-CAT-05 (identidad por `katalyst.stableKey`, no por título), RF-EJE-08, RF-RES-01.
 */

export const STABLE_KEY_ANNOTATION = 'katalyst.stableKey';
export const PARAMETER_KEY_ANNOTATION = 'katalyst.parameterKey';
export const DEFAULT_PARAMETER_KEY = 'default';

export function testKey(stableKey: string, parameterKey: string): string {
  return `${stableKey.toLowerCase()}::${parameterKey}`;
}

/** Plan de una invocación de Playwright (lo escribe el ejecutor; `KATALYST_REPORTER_PLAN_FILE`). */
export interface ReporterPlan {
  schemaVersion: 1;
  /** Project de ambiente esperado (`--project`); `null` = cualquiera. */
  projectName: string | null;
  tests: Array<{ stableKey: string; parameterKey: string }>;
  /** Flags que deben estar en `use.launchOptions.args` del project (RNF-CON-03). */
  requiredChromiumFlags: string[];
}

export interface PlannedTestInfo {
  key: string;
  testId: string;
  title: string;
  file: string;
  line: number;
  projectName: string;
  retries: number;
}

export interface ReporterErrorInfo {
  message?: string;
  stack?: string;
  value?: string;
}

export interface ReporterAttachmentInfo {
  name: string;
  contentType: string;
  path?: string;
}

export type ReporterMessage =
  | {
      type: 'plan';
      found: PlannedTestInfo[];
      missing: string[];
      unmapped: Array<{ title: string; file: string; projectName: string }>;
      duplicates: string[];
      missingChromiumFlags: string[];
    }
  | {
      type: 'testBegin';
      key: string | null;
      testId: string;
      title: string;
      projectName: string;
      isSetup: boolean;
      retry: number;
      startTime: string;
    }
  | {
      type: 'testEnd';
      key: string | null;
      testId: string;
      title: string;
      projectName: string;
      isSetup: boolean;
      retry: number;
      retries: number;
      status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
      expectedStatus: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
      startTime: string;
      duration: number;
      timeoutMs: number;
      errors: ReporterErrorInfo[];
      annotations: Array<{ type: string; description?: string }>;
      attachments: ReporterAttachmentInfo[];
      willRetry: boolean;
    }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'end'; status: 'passed' | 'failed' | 'timedout' | 'interrupted' };

export const REPORTER_ENV = {
  planFile: 'KATALYST_REPORTER_PLAN_FILE',
  eventsFile: 'KATALYST_REPORTER_EVENTS_FILE',
} as const;
