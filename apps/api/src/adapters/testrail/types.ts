/**
 * Contrato del adaptador TestRail (API REST v2, ESP §8). Tipos con los campos que Katalyst usa; el resto se conserva
 * como `Record<string, unknown>` para registrar campos personalizados no soportados (ESP §8 "registrar campos no
 * soportados sin descartar silenciosamente verificaciones").
 * RF-TR-01, RF-TR-02, RF-TR-04, RF-TR-05, RF-TR-06, RF-TR-08.
 */

export interface TrProject {
  id: number;
  name: string;
  is_completed?: boolean;
  suite_mode?: number;
}

export interface TrSuite {
  id: number;
  name: string;
  project_id: number;
  is_completed?: boolean;
}

export interface TrSection {
  id: number;
  suite_id: number;
  name: string;
  parent_id: number | null;
  depth: number;
  display_order: number;
}

export interface TrStepSeparated {
  content?: string | null;
  expected?: string | null;
  additional_info?: string | null;
  refs?: string | null;
  shared_step_id?: number | null;
}

export interface TrCase {
  id: number;
  title: string;
  section_id: number;
  suite_id: number;
  priority_id?: number | null;
  type_id?: number | null;
  refs?: string | null;
  updated_on?: number | null;
  custom_steps?: string | null;
  custom_expected?: string | null;
  custom_preconds?: string | null;
  custom_steps_separated?: TrStepSeparated[] | null;
  [field: string]: unknown;
}

export interface TrRun {
  id: number;
  name: string;
  description?: string | null;
  suite_id: number | null;
  project_id: number;
  plan_id?: number | null;
  is_completed: boolean;
  created_on?: number;
  url?: string;
}

export interface TrResult {
  id: number;
  test_id: number;
  status_id: number | null;
  comment?: string | null;
  created_on?: number;
}

export interface TrTest {
  id: number;
  case_id: number;
  run_id: number;
  title: string;
  status_id?: number | null;
}

export interface TrPlanEntry {
  id: string;
  suite_id: number;
  name: string;
  runs: TrRun[];
}

export interface TrPlan {
  id: number;
  name: string;
  project_id: number;
  is_completed: boolean;
  entries: TrPlanEntry[];
}

export interface TrAttachment {
  id: number | string;
  name?: string;
  filename?: string;
  result_id?: number | null;
}

export interface TrPriority {
  id: number;
  name: string;
  short_name?: string;
}

export interface TrCaseType {
  id: number;
  name: string;
}

export interface TrResultInput {
  case_id: number;
  status_id: number;
  comment?: string;
  elapsed?: string | null;
}

export interface TrAddRunInput {
  suite_id: number;
  name: string;
  description?: string;
  include_all: false;
  case_ids: number[];
}

export type TestRailErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'blocked';

/** Error normalizado del adaptador. El mensaje nunca incluye credenciales ni cuerpos completos. */
export class TestRailError extends Error {
  constructor(
    readonly kind: TestRailErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    /** La operación pudo haberse aplicado (timeout/red tras enviar un POST). */
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'TestRailError';
  }

  /** ¿Reintentable automáticamente? 401/403/validación/404 no (requieren intervención). */
  get transient(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }
}

export interface Paged<T> {
  items: T[];
  /** Hay más páginas. */
  hasMore: boolean;
}

/**
 * Cliente TestRail. Implementaciones: HTTP real (`HttpTestRailClient`) y en memoria (`FakeTestRailClient`, pruebas).
 * Los métodos `*Pages` recorren `offset/limit/_links.next` y entregan página por página (staging transaccional).
 */
export interface TestRailClient {
  getProjects(): Promise<TrProject[]>;
  getSuites(projectId: number): Promise<TrSuite[]>;
  getSectionsPages(projectId: number, suiteId: number): AsyncIterable<TrSection[]>;
  getCasesPages(projectId: number, suiteId: number): AsyncIterable<TrCase[]>;
  getPriorities(): Promise<TrPriority[]>;
  getCaseTypes(): Promise<TrCaseType[]>;
  addRun(projectId: number, input: TrAddRunInput): Promise<TrRun>;
  getRuns(projectId: number, filter?: { suiteId?: number; createdAfter?: number }): Promise<TrRun[]>;
  getRun(runId: number): Promise<TrRun>;
  addResultsForCases(runId: number, results: TrResultInput[]): Promise<TrResult[]>;
  getResultsForRun(runId: number): Promise<TrResult[]>;
  getTests(runId: number): Promise<TrTest[]>;
  addAttachmentToResult(resultId: number, fileName: string, contentType: string, content: Buffer): Promise<{ attachment_id: number | string }>;
  getAttachmentsForTest(testId: number): Promise<TrAttachment[]>;
  closeRun(runId: number): Promise<TrRun>;
  getPlan(planId: number): Promise<TrPlan>;
}
