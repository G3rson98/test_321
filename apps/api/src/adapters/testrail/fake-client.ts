/**
 * TestRail en memoria para pruebas (ESP §14: paginación, cambio de caso, archivado, múltiples suites, fallo parcial,
 * 429, timeout ambiguo, 401 permanente). Inyección de fallas por operación:
 * - `failNext(op, error, times?)`: la siguiente llamada falla SIN aplicar.
 * - `applyThenFail(op, error)`: la llamada se APLICA y luego falla (timeout ambiguo).
 */
import {
  TestRailError,
  type TestRailClient,
  type TrAddRunInput,
  type TrAttachment,
  type TrCase,
  type TrCaseType,
  type TrPlan,
  type TrPriority,
  type TrProject,
  type TrResult,
  type TrResultInput,
  type TrRun,
  type TrSection,
  type TrSuite,
  type TrTest,
} from './types.js';

export type FakeOp =
  | 'getProjects'
  | 'getSuites'
  | 'getSections'
  | 'getCases'
  | 'addRun'
  | 'getRuns'
  | 'addResultsForCases'
  | 'getResultsForRun'
  | 'getTests'
  | 'addAttachmentToResult'
  | 'getAttachmentsForTest'
  | 'closeRun'
  | 'getPlan'
  | 'getRun';

interface Fault {
  error: TestRailError;
  times: number;
  applyFirst: boolean;
  /** Fallar en la página N (0-based) de una operación paginada. */
  page?: number;
}

export class FakeTestRailClient implements TestRailClient {
  projects: TrProject[] = [];
  suites: TrSuite[] = [];
  sections: TrSection[] = [];
  cases: TrCase[] = [];
  runs: TrRun[] = [];
  tests: TrTest[] = [];
  results: TrResult[] = [];
  attachments: (TrAttachment & { result_id: number })[] = [];
  plans: TrPlan[] = [];
  priorities: TrPriority[] = [
    { id: 1, name: 'Low' },
    { id: 2, name: 'Medium' },
    { id: 3, name: 'High' },
  ];
  caseTypes: TrCaseType[] = [
    { id: 1, name: 'Functional' },
    { id: 2, name: 'Smoke' },
  ];
  pageSize = 2;
  calls: { op: FakeOp; args: unknown[] }[] = [];
  private faults = new Map<FakeOp, Fault[]>();
  private nextId: number;

  /** `startId`: base de IDs externos (distintas instancias no colisionan en la misma BD de pruebas). */
  constructor(startId = 1000) {
    this.nextId = startId;
  }

  failNext(op: FakeOp, error: TestRailError, times = 1, page?: number): this {
    const list = this.faults.get(op) ?? [];
    list.push({ error, times, applyFirst: false, ...(page !== undefined ? { page } : {}) });
    this.faults.set(op, list);
    return this;
  }

  applyThenFail(op: FakeOp, error: TestRailError = new TestRailError('timeout', 'timeout', null, null, true)): this {
    const list = this.faults.get(op) ?? [];
    list.push({ error, times: 1, applyFirst: true });
    this.faults.set(op, list);
    return this;
  }

  clearFaults(): void {
    this.faults.clear();
  }

  count(op: FakeOp): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private take(op: FakeOp, page?: number): Fault | undefined {
    const list = this.faults.get(op);
    if (!list || list.length === 0) return undefined;
    const f = list[0]!;
    if (f.page !== undefined && f.page !== page) return undefined;
    f.times--;
    if (f.times <= 0) list.shift();
    return f;
  }

  private async run<T>(op: FakeOp, args: unknown[], fn: () => T): Promise<T> {
    this.calls.push({ op, args });
    const f = this.take(op);
    if (f && !f.applyFirst) throw f.error;
    const out = fn();
    if (f && f.applyFirst) throw f.error;
    return out;
  }

  private async *paged<T>(op: FakeOp, args: unknown[], all: () => T[]): AsyncIterable<T[]> {
    this.calls.push({ op, args });
    const items = all();
    const pages = Math.max(1, Math.ceil(items.length / this.pageSize));
    for (let p = 0; p < pages; p++) {
      const f = this.take(op, p);
      if (f) throw f.error;
      yield items.slice(p * this.pageSize, (p + 1) * this.pageSize).map((x) => structuredClone(x));
    }
  }

  // --- helpers de siembra ---
  addProject(name: string): TrProject {
    const p = { id: this.nextId++, name };
    this.projects.push(p);
    return p;
  }
  addSuite(projectId: number, name: string): TrSuite {
    const s = { id: this.nextId++, name, project_id: projectId };
    this.suites.push(s);
    return s;
  }
  addSection(suiteId: number, name: string, parentId: number | null = null): TrSection {
    const parent = parentId ? this.sections.find((x) => x.id === parentId) : undefined;
    const s = { id: this.nextId++, suite_id: suiteId, name, parent_id: parentId, depth: parent ? parent.depth + 1 : 0, display_order: this.sections.length };
    this.sections.push(s);
    return s;
  }
  addCase(sectionId: number, title: string, extra: Partial<TrCase> = {}): TrCase {
    const sec = this.sections.find((x) => x.id === sectionId)!;
    const c: TrCase = { id: this.nextId++, title, section_id: sectionId, suite_id: sec.suite_id, priority_id: 2, type_id: 1, refs: null, ...extra };
    this.cases.push(c);
    return c;
  }

  // --- TestRailClient ---
  getProjects(): Promise<TrProject[]> {
    return this.run('getProjects', [], () => structuredClone(this.projects));
  }
  getSuites(projectId: number): Promise<TrSuite[]> {
    return this.run('getSuites', [projectId], () => this.suites.filter((s) => s.project_id === projectId).map((s) => ({ ...s })));
  }
  getSectionsPages(projectId: number, suiteId: number): AsyncIterable<TrSection[]> {
    return this.paged('getSections', [projectId, suiteId], () => this.sections.filter((s) => s.suite_id === suiteId));
  }
  getCasesPages(projectId: number, suiteId: number): AsyncIterable<TrCase[]> {
    return this.paged('getCases', [projectId, suiteId], () => this.cases.filter((c) => c.suite_id === suiteId));
  }
  async getPriorities(): Promise<TrPriority[]> {
    return this.priorities;
  }
  async getCaseTypes(): Promise<TrCaseType[]> {
    return this.caseTypes;
  }
  addRun(projectId: number, input: TrAddRunInput): Promise<TrRun> {
    return this.run('addRun', [projectId, input], () => {
      const run: TrRun = {
        id: this.nextId++,
        name: input.name,
        description: input.description ?? null,
        suite_id: input.suite_id,
        project_id: projectId,
        is_completed: false,
        created_on: Math.floor(Date.now() / 1000),
      };
      this.runs.push(run);
      for (const cid of input.case_ids) {
        const c = this.cases.find((x) => x.id === cid);
        if (!c) throw new TestRailError('validation', 'Field :case_ids contains invalid case', 400);
        this.tests.push({ id: this.nextId++, case_id: cid, run_id: run.id, title: c.title });
      }
      return { ...run };
    });
  }
  getRuns(projectId: number, filter: { suiteId?: number; createdAfter?: number } = {}): Promise<TrRun[]> {
    return this.run('getRuns', [projectId, filter], () =>
      this.runs
        .filter((r) => r.project_id === projectId)
        .filter((r) => filter.suiteId === undefined || r.suite_id === filter.suiteId)
        .filter((r) => filter.createdAfter === undefined || (r.created_on ?? 0) >= filter.createdAfter)
        .map((r) => ({ ...r })),
    );
  }
  getRun(runId: number): Promise<TrRun> {
    return this.run('getRun', [runId], () => {
      const r = this.runs.find((x) => x.id === runId);
      if (!r) throw new TestRailError('not_found', 'run not found', 404);
      return { ...r };
    });
  }
  addResultsForCases(runId: number, results: TrResultInput[]): Promise<TrResult[]> {
    return this.run('addResultsForCases', [runId, results], () => {
      const run = this.runs.find((x) => x.id === runId);
      if (!run) throw new TestRailError('not_found', 'run not found', 404);
      if (run.is_completed) throw new TestRailError('validation', 'run is completed', 400);
      const out: TrResult[] = [];
      for (const r of results) {
        const t = this.tests.find((x) => x.run_id === runId && x.case_id === r.case_id);
        if (!t) throw new TestRailError('validation', 'case not in run', 400);
        const res: TrResult = { id: this.nextId++, test_id: t.id, status_id: r.status_id, comment: r.comment ?? null };
        this.results.push(res);
        t.status_id = r.status_id;
        out.push(res);
      }
      return out;
    });
  }
  getResultsForRun(runId: number): Promise<TrResult[]> {
    return this.run('getResultsForRun', [runId], () => {
      const testIds = new Set(this.tests.filter((t) => t.run_id === runId).map((t) => t.id));
      return this.results.filter((r) => testIds.has(r.test_id)).map((r) => ({ ...r }));
    });
  }
  getTests(runId: number): Promise<TrTest[]> {
    return this.run('getTests', [runId], () => this.tests.filter((t) => t.run_id === runId).map((t) => ({ ...t })));
  }
  addAttachmentToResult(resultId: number, fileName: string, _ct: string, content: Buffer): Promise<{ attachment_id: number }> {
    return this.run('addAttachmentToResult', [resultId, fileName, content.length], () => {
      if (!this.results.some((r) => r.id === resultId)) throw new TestRailError('not_found', 'result not found', 404);
      const id = this.nextId++;
      this.attachments.push({ id, name: fileName, filename: fileName, result_id: resultId });
      return { attachment_id: id };
    });
  }
  getAttachmentsForTest(testId: number): Promise<TrAttachment[]> {
    return this.run('getAttachmentsForTest', [testId], () => {
      const resultIds = new Set(this.results.filter((r) => r.test_id === testId).map((r) => r.id));
      return this.attachments.filter((a) => resultIds.has(a.result_id)).map((a) => ({ ...a }));
    });
  }
  closeRun(runId: number): Promise<TrRun> {
    return this.run('closeRun', [runId], () => {
      const r = this.runs.find((x) => x.id === runId);
      if (!r) throw new TestRailError('not_found', 'run not found', 404);
      if (r.is_completed) throw new TestRailError('validation', 'run is already completed', 400);
      r.is_completed = true;
      return { ...r };
    });
  }
  getPlan(planId: number): Promise<TrPlan> {
    return this.run('getPlan', [planId], () => {
      const p = this.plans.find((x) => x.id === planId);
      if (!p) throw new TestRailError('not_found', 'plan not found', 404);
      return structuredClone(p);
    });
  }
}
