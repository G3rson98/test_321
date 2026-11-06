/**
 * Publicación durable y reconciliable a TestRail (RF-TR-04, RF-TR-05, RF-TR-06, RF-TR-08, ESP §8, §13.4).
 *
 * `enqueueTestRailPublication(tx, runId)` — lo invoca API-B en la transacción que deja la corrida en estado terminal
 * con `case_result` finales — crea por destino (`run_testrail_target`) las entregas ordenadas:
 *   seq 0     `testrail.add_run`                (si no es corrida preexistente)
 *   seq 10+i  `testrail.add_results_for_cases`  (lotes ≤ 100 casos publicables con agregado final)
 *   seq 1000  `testrail.add_attachment_to_result` (solo capturas `sanitizado` de casos fallidos)
 *   seq 2000  `testrail.close_run`              (nunca una corrida preexistente salvo `close_existing_run`)
 * Sin casos publicables (p. ej. cancelada antes de iniciar) no se crea destino externo (`no_aplica`).
 *
 * Idempotencia: TestRail no garantiza idempotencia; nombre/descripcion/comentarios llevan `[katalyst-run:<uuid>]` y los
 * adjuntos `katalyst-<artifactId>`. Si el intento previo pudo aplicarse (timeout ambiguo, proceso caído, reintento),
 * el handler RECONCILIA por marcador antes de repetir; si no puede determinarlo (permisos/API) → intervención.
 */
import type { OutboxDelivery, Prisma, PrismaClient } from '@prisma/client';
import {
  chunk,
  runMarker,
  sanitizeErrorMessage,
  testrailRunName,
  testrailStatusIdFor,
  toTestRailElapsed,
  type CaseResultStatus,
} from '@katalyst/shared';
import type { Config } from '../../config.js';
import type { TestRailClientFactory } from '../../adapters/testrail/index.js';
import { TestRailError, type TestRailClient, type TrResultInput } from '../../adapters/testrail/types.js';
import { publishEvent } from '../../lib/events-publish.js';
import {
  enqueueOutbox,
  registerOutboxHandler,
  type OutboxCtx,
  type OutboxHandlerResult,
  type ReconciliationOutcome,
} from '../../lib/outbox.js';
import { SecretUnavailableError, type SecretProvider } from '../../lib/secrets.js';

export const TR_SEQ = { addRun: 0, results: 10, attachments: 1000, close: 2000 } as const;
export const MAX_ATTACHMENTS_PER_CASE = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export interface AddRunPayload {
  targetId: string;
}
export interface AddResultsPayload {
  targetId: string;
  caseResultIds: string[];
}
export interface AttachmentPayload {
  targetId: string;
  caseResultId: string;
  artifactId: string;
}
export interface CloseRunPayload {
  targetId: string;
}

// ---------------------------------------------------------------------------
// Encolado (API-B lo llama al finalizar la corrida)
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  targets: { targetId: string; deliveries: number; syncStatus: string }[];
}

export async function enqueueTestRailPublication(tx: Tx, runId: string): Promise<EnqueueResult> {
  const targets = await tx.runTestRailTarget.findMany({
    where: { runId },
    include: { caseResults: { select: { id: true, status: true, publishable: true, caseId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const out: EnqueueResult = { targets: [] };
  for (const t of targets) {
    const publishable = t.caseResults.filter(
      (cr) => cr.publishable && testrailStatusIdFor(cr.status as CaseResultStatus) !== null,
    );
    if (publishable.length === 0) {
      await tx.runTestRailTarget.update({ where: { id: t.id }, data: { syncStatus: 'no_aplica' } });
      out.targets.push({ targetId: t.id, deliveries: 0, syncStatus: 'no_aplica' });
      continue;
    }
    let n = 0;
    if (!t.existingRun) {
      await enqueueOutbox(tx, {
        operation: 'testrail.add_run',
        dedupKey: `tr:add_run:${t.id}`,
        payload: { targetId: t.id } satisfies AddRunPayload,
        runId,
        targetId: t.id,
        sequence: TR_SEQ.addRun,
      });
      n++;
    }
    const batches = chunk(
      [...publishable].sort((a, b) => a.id.localeCompare(b.id)),
      100,
    );
    for (let i = 0; i < batches.length; i++) {
      await enqueueOutbox(tx, {
        operation: 'testrail.add_results_for_cases',
        dedupKey: `tr:results:${t.id}:${i}`,
        payload: { targetId: t.id, caseResultIds: batches[i]!.map((c) => c.id) } satisfies AddResultsPayload,
        runId,
        targetId: t.id,
        sequence: TR_SEQ.results + i,
      });
      n++;
    }
    // Capturas sanitizadas de tests fallidos vinculados a casos fallidos (RF-TR-05).
    for (const cr of publishable.filter((c) => c.status === 'fallido')) {
      const artifacts = await tx.artifact.findMany({
        where: {
          runId,
          kind: 'captura',
          sanitizationStatus: 'sanitizado',
          storageKey: { not: null },
          runResult: { status: 'fallido', automatedTest: { links: { some: { caseId: cr.caseId } } } },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_ATTACHMENTS_PER_CASE,
        select: { id: true },
      });
      for (const a of artifacts) {
        await enqueueOutbox(tx, {
          operation: 'testrail.add_attachment_to_result',
          dedupKey: `tr:attach:${t.id}:${cr.id}:${a.id}`,
          payload: { targetId: t.id, caseResultId: cr.id, artifactId: a.id } satisfies AttachmentPayload,
          runId,
          targetId: t.id,
          sequence: TR_SEQ.attachments,
        });
        n++;
      }
    }
    if (!t.existingRun || t.closeExistingRun) {
      await enqueueOutbox(tx, {
        operation: 'testrail.close_run',
        dedupKey: `tr:close:${t.id}`,
        payload: { targetId: t.id } satisfies CloseRunPayload,
        runId,
        targetId: t.id,
        sequence: TR_SEQ.close,
      });
      n++;
    }
    await tx.runTestRailTarget.update({ where: { id: t.id }, data: { syncStatus: 'pendiente', lastError: null } });
    await tx.caseResult.updateMany({ where: { id: { in: publishable.map((c) => c.id) } }, data: { syncStatus: 'pendiente' } });
    out.targets.push({ targetId: t.id, deliveries: n, syncStatus: 'pendiente' });
  }
  await recomputeRunSyncStatus(tx, runId);
  return out;
}

/** `run.sync_status` derivado de sus destinos (no cambia el resultado funcional, ESP §13.2). */
export async function recomputeRunSyncStatus(tx: Tx, runId: string): Promise<void> {
  const targets = await tx.runTestRailTarget.findMany({ where: { runId }, select: { id: true, syncStatus: true } });
  const st = targets.map((t) => t.syncStatus);
  let next: 'no_aplica' | 'pendiente' | 'enviando' | 'sincronizada' | 'requiere_intervencion';
  if (st.length === 0 || st.every((s) => s === 'no_aplica')) next = 'no_aplica';
  else if (st.some((s) => s === 'requiere_intervencion')) next = 'requiere_intervencion';
  else if (st.every((s) => s === 'sincronizada' || s === 'no_aplica')) next = 'sincronizada';
  else if (st.some((s) => s === 'enviando' || s === 'sincronizada')) next = 'enviando';
  else next = 'pendiente';
  const run = await tx.run.findUnique({ where: { id: runId }, select: { syncStatus: true, version: true, environmentId: true } });
  if (!run || run.syncStatus === next) return;
  const updated = await tx.run.update({
    where: { id: runId },
    data: { syncStatus: next, version: { increment: 1 } },
    select: { version: true },
  });
  await publishEvent(tx, {
    type: 'sync.updated',
    entity: 'run',
    entityId: runId,
    version: updated.version,
    runId,
    environmentId: run.environmentId,
    data: { syncStatus: next, targets: targets.map((t) => ({ id: t.id, syncStatus: t.syncStatus })) },
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export type ArtifactReader = (storageKey: string) => Promise<Buffer>;

export interface PublicationDeps {
  config: Pick<Config, 'PUBLIC_BASE_URL' | 'DEFAULT_TIMEZONE'> & Partial<Config>;
  clientFactory: TestRailClientFactory;
  artifactReader?: ArtifactReader;
}

async function loadTarget(db: Db, targetId: string) {
  return db.runTestRailTarget.findUnique({
    where: { id: targetId },
    include: {
      run: { select: { id: true, createdAt: true, environment: { select: { name: true } } } },
      testrailSuite: {
        select: {
          externalId: true,
          name: true,
          project: { select: { externalId: true } },
          connection: { select: { baseUrl: true, username: true, secretRef: true } },
        },
      },
    },
  });
}
type LoadedTarget = NonNullable<Awaited<ReturnType<typeof loadTarget>>>;

export function runUrl(config: { PUBLIC_BASE_URL: string }, runId: string): string {
  return new URL(`/runs/${runId}`, config.PUBLIC_BASE_URL).toString();
}

export function localDateTime(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

/** Traduce errores del adaptador al resultado del publicador (ESP §13.4). */
export function mapTestRailError(e: unknown): OutboxHandlerResult {
  if (e instanceof SecretUnavailableError) return { kind: 'intervention', error: 'API key de TestRail no disponible' };
  if (e instanceof TestRailError) {
    if (e.kind === 'rate_limited') return { kind: 'retry', error: e.message, httpStatus: 429, retryAfterMs: e.retryAfterMs ?? 60_000 };
    if (e.transient) return { kind: 'retry', error: e.message, ...(e.status ? { httpStatus: e.status } : {}), ambiguous: e.ambiguous };
    return { kind: 'intervention', error: e.message, ...(e.status ? { httpStatus: e.status } : {}) };
  }
  throw e;
}

function ensureMarker(comment: string | null, runId: string, url: string, status: string): string {
  const marker = runMarker(runId);
  const base = comment && comment.trim().length > 0 ? comment : `Katalyst · ${status}\nDetalle: ${url}`;
  return base.includes(marker) ? base : `${base}\n${marker}`;
}

async function clientFor(deps: PublicationDeps, t: LoadedTarget): Promise<TestRailClient> {
  return deps.clientFactory(t.testrailSuite.connection);
}

/** Busca la corrida externa creada para este destino por marcador (reconciliación tras timeout ambiguo). */
async function findExistingRun(client: TestRailClient, t: LoadedTarget): Promise<number | null> {
  const marker = runMarker(t.run.id);
  const runs = await client.getRuns(t.testrailSuite.project.externalId, {
    suiteId: t.testrailSuite.externalId,
    createdAfter: Math.floor(t.run.createdAt.getTime() / 1000) - 3600,
  });
  const found = runs.find((r) => `${r.name ?? ''}\n${r.description ?? ''}`.includes(marker));
  return found ? found.id : null;
}

async function markTargetSending(db: Db, targetId: string, data: Prisma.RunTestRailTargetUpdateInput): Promise<void> {
  await db.runTestRailTarget.update({ where: { id: targetId }, data: { syncStatus: 'enviando', ...data } });
}

export function makeAddRunHandler(deps: PublicationDeps) {
  return async (d: OutboxDelivery, ctx: OutboxCtx): Promise<OutboxHandlerResult> => {
    const { targetId } = d.payload as unknown as AddRunPayload;
    const t = await loadTarget(ctx.prisma, targetId);
    if (!t) return { kind: 'cancelled', reason: 'destino inexistente' };
    if (t.trRunId) return { kind: 'delivered', externalId: String(t.trRunId), note: 'ya creada' };
    try {
      const client = await clientFor(deps, t);
      if (ctx.attempt > 1 || ctx.previousAmbiguous) {
        const existing = await findExistingRun(client, t);
        if (existing) {
          await ctx.prisma.$transaction(async (tx) => {
            await markTargetSending(tx, t.id, { trRunId: existing });
            await recomputeRunSyncStatus(tx, t.runId);
          });
          return { kind: 'delivered', externalId: String(existing), note: 'reconciliada por marcador' };
        }
      }
      const crs = await ctx.prisma.caseResult.findMany({
        where: { runTestRailTargetId: t.id },
        select: { case: { select: { trCaseId: true } } },
      });
      const caseIds = [...new Set(crs.map((c) => c.case.trCaseId))].sort((a, b) => a - b);
      const name = testrailRunName(
        t.testrailSuite.name.slice(0, 80),
        t.run.environment.name.slice(0, 60),
        localDateTime(t.run.createdAt, deps.config.DEFAULT_TIMEZONE),
        t.run.id,
      );
      const created = await client.addRun(t.testrailSuite.project.externalId, {
        suite_id: t.testrailSuite.externalId,
        name,
        description: `${runMarker(t.run.id)}\nDetalle: ${runUrl(deps.config, t.run.id)}`,
        include_all: false,
        case_ids: caseIds,
      });
      await ctx.prisma.$transaction(async (tx) => {
        await markTargetSending(tx, t.id, { trRunId: created.id });
        await recomputeRunSyncStatus(tx, t.runId);
      });
      return { kind: 'delivered', externalId: String(created.id) };
    } catch (e) {
      return mapTestRailError(e);
    }
  };
}

async function reconcileResults(
  client: TestRailClient,
  db: Db,
  t: LoadedTarget,
  pending: { id: string; trCaseId: number }[],
): Promise<Set<string>> {
  const marker = runMarker(t.run.id);
  const [results, tests] = await Promise.all([client.getResultsForRun(t.trRunId!), client.getTests(t.trRunId!)]);
  const caseByTest = new Map(tests.map((x) => [x.id, x.case_id]));
  const applied = new Set<string>();
  for (const r of results) {
    if (!(r.comment ?? '').includes(marker)) continue;
    const caseId = caseByTest.get(r.test_id);
    const cr = pending.find((p) => p.trCaseId === caseId);
    if (cr && !applied.has(cr.id)) {
      applied.add(cr.id);
      await db.caseResult.update({ where: { id: cr.id }, data: { trResultId: r.id, syncStatus: 'sincronizada' } });
    }
  }
  return applied;
}

export function makeAddResultsHandler(deps: PublicationDeps) {
  return async (d: OutboxDelivery, ctx: OutboxCtx): Promise<OutboxHandlerResult> => {
    const { targetId, caseResultIds } = d.payload as unknown as AddResultsPayload;
    const t = await loadTarget(ctx.prisma, targetId);
    if (!t) return { kind: 'cancelled', reason: 'destino inexistente' };
    if (!t.trRunId) return { kind: 'defer', untilMs: 15_000, reason: 'esperando corrida externa' };
    const crs = await ctx.prisma.caseResult.findMany({
      where: { id: { in: caseResultIds }, runTestRailTargetId: t.id },
      include: { case: { select: { trCaseId: true } } },
      orderBy: { id: 'asc' },
    });
    let pending = crs.filter((c) => c.trResultId === null).map((c) => ({ ...c, trCaseId: c.case.trCaseId }));
    if (pending.length === 0) return { kind: 'delivered', note: 'sin resultados pendientes' };
    try {
      const client = await clientFor(deps, t);
      if (ctx.attempt > 1 || ctx.previousAmbiguous) {
        const applied = await reconcileResults(client, ctx.prisma, t, pending);
        pending = pending.filter((p) => !applied.has(p.id));
        if (pending.length === 0) return { kind: 'delivered', note: 'reconciliada por marcador' };
      }
      if (t.existingRun) {
        // RF-TR-06: nunca cambiar la selección de una corrida preexistente; casos ajenos quedan para intervención.
        const inRun = new Set((await client.getTests(t.trRunId)).map((x) => x.case_id));
        const outside = pending.filter((p) => !inRun.has(p.trCaseId));
        if (outside.length > 0) {
          await ctx.prisma.caseResult.updateMany({
            where: { id: { in: outside.map((o) => o.id) } },
            data: { syncStatus: 'requiere_intervencion' },
          });
          await ctx.prisma.runTestRailTarget.update({
            where: { id: t.id },
            data: { lastError: `${outside.length} caso(s) no pertenecen a la corrida preexistente` },
          });
        }
        pending = pending.filter((p) => inRun.has(p.trCaseId));
        if (pending.length === 0) return { kind: 'delivered', note: 'sin casos de la corrida preexistente' };
      }
      const url = runUrl(deps.config, t.run.id);
      const body: TrResultInput[] = pending.map((p) => ({
        case_id: p.trCaseId,
        status_id: testrailStatusIdFor(p.status as CaseResultStatus)!,
        comment: ensureMarker(p.comment, t.run.id, url, p.status),
        elapsed: toTestRailElapsed(p.durationMs),
      }));
      const res = await client.addResultsForCases(t.trRunId, body);
      let byCase: Map<number, number>;
      if (res.length === body.length) {
        byCase = new Map(body.map((b, i) => [b.case_id, res[i]!.id]));
      } else {
        const tests = await client.getTests(t.trRunId);
        const caseByTest = new Map(tests.map((x) => [x.id, x.case_id]));
        byCase = new Map(res.map((r) => [caseByTest.get(r.test_id) ?? -1, r.id]));
      }
      await ctx.prisma.$transaction(async (tx) => {
        for (const p of pending) {
          const id = byCase.get(p.trCaseId);
          await tx.caseResult.update({
            where: { id: p.id },
            data: { trResultId: id ?? null, syncStatus: id ? 'sincronizada' : 'requiere_intervencion' },
          });
        }
      });
      return { kind: 'delivered', externalId: res[0] ? String(res[0].id) : null };
    } catch (e) {
      return mapTestRailError(e);
    }
  };
}

async function defaultArtifactReader(config: Partial<Config>, secrets: SecretProvider | undefined): Promise<ArtifactReader> {
  const { createArtifactStore } = await import('../../adapters/artifact-store/index.js');
  const store = await createArtifactStore(config as Config, secrets ? (r) => secrets.get(r) : undefined);
  return async (key) => {
    const stream = await store.getStream(key);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of stream) {
      size += (c as Buffer).length;
      if (size > MAX_ATTACHMENT_BYTES) throw new Error('adjunto excede el tamaño permitido');
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  };
}

function attachmentName(artifactId: string, contentType: string): string {
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
  return `katalyst-${artifactId}.${ext}`;
}

async function findAttachment(client: TestRailClient, trRunId: number, trCaseId: number, artifactId: string): Promise<string | null> {
  const test = (await client.getTests(trRunId)).find((x) => x.case_id === trCaseId);
  if (!test) return null;
  const atts = await client.getAttachmentsForTest(test.id);
  const a = atts.find((x) => `${x.name ?? ''} ${x.filename ?? ''}`.includes(artifactId));
  return a ? String(a.id) : null;
}

export function makeAttachmentHandler(deps: PublicationDeps, secrets?: SecretProvider) {
  let reader: ArtifactReader | undefined = deps.artifactReader;
  return async (d: OutboxDelivery, ctx: OutboxCtx): Promise<OutboxHandlerResult> => {
    const { targetId, caseResultId, artifactId } = d.payload as unknown as AttachmentPayload;
    const t = await loadTarget(ctx.prisma, targetId);
    if (!t || !t.trRunId) return { kind: 'cancelled', reason: 'sin corrida externa' };
    const cr = await ctx.prisma.caseResult.findUnique({ where: { id: caseResultId }, include: { case: { select: { trCaseId: true } } } });
    if (!cr || cr.trResultId === null) return { kind: 'cancelled', reason: 'resultado no publicado; evidencia incompleta' };
    const art = await ctx.prisma.artifact.findUnique({ where: { id: artifactId } });
    // ESP §13.7: solo evidencia sanitizada y permitida; si no, se registra la ausencia sin subirla.
    if (!art || art.runId !== t.runId || art.kind !== 'captura' || art.sanitizationStatus !== 'sanitizado' || !art.storageKey) {
      return { kind: 'cancelled', reason: 'captura no publicable (no sanitizada o deshabilitada)' };
    }
    if (art.sizeBytes !== null && Number(art.sizeBytes) > MAX_ATTACHMENT_BYTES) {
      return { kind: 'cancelled', reason: 'captura excede el tamaño permitido para TestRail' };
    }
    try {
      const client = await clientFor(deps, t);
      if (ctx.attempt > 1 || ctx.previousAmbiguous) {
        const found = await findAttachment(client, t.trRunId, cr.case.trCaseId, art.id);
        if (found) return { kind: 'delivered', externalId: found, note: 'reconciliada por nombre' };
      }
      reader ??= await defaultArtifactReader(deps.config, secrets ?? ctx.secrets);
      const content = await reader(art.storageKey);
      const res = await client.addAttachmentToResult(cr.trResultId, attachmentName(art.id, art.contentType), art.contentType, content);
      return { kind: 'delivered', externalId: String(res.attachment_id) };
    } catch (e) {
      if (e instanceof TestRailError || e instanceof SecretUnavailableError) return mapTestRailError(e);
      return { kind: 'retry', error: sanitizeErrorMessage(e instanceof Error ? e.message : String(e), 500), ambiguous: true };
    }
  };
}

export function makeCloseRunHandler(deps: PublicationDeps) {
  return async (d: OutboxDelivery, ctx: OutboxCtx): Promise<OutboxHandlerResult> => {
    const { targetId } = d.payload as unknown as CloseRunPayload;
    const t = await loadTarget(ctx.prisma, targetId);
    if (!t || !t.trRunId) return { kind: 'cancelled', reason: 'sin corrida externa' };
    if (t.existingRun && !t.closeExistingRun) return { kind: 'cancelled', reason: 'corrida preexistente sin opción de cierre' };
    try {
      const client = await clientFor(deps, t);
      if (ctx.attempt > 1 || ctx.previousAmbiguous) {
        const r = await client.getRun(t.trRunId);
        if (r.is_completed) return { kind: 'delivered', externalId: String(t.trRunId), note: 'ya cerrada' };
      }
      await client.closeRun(t.trRunId);
      return { kind: 'delivered', externalId: String(t.trRunId) };
    } catch (e) {
      if (e instanceof TestRailError && e.kind === 'validation' && /completed|closed|cerrad/i.test(e.message)) {
        return { kind: 'delivered', externalId: String(t.trRunId), note: 'ya cerrada' };
      }
      return mapTestRailError(e);
    }
  };
}

// ---------------------------------------------------------------------------
// Reconciliación administrativa y hooks terminales
// ---------------------------------------------------------------------------

function reconcileWrap(fn: (d: OutboxDelivery, ctx: OutboxCtx) => Promise<ReconciliationOutcome>) {
  return async (d: OutboxDelivery, ctx: OutboxCtx): Promise<ReconciliationOutcome> => {
    try {
      return await fn(d, ctx);
    } catch (e) {
      return { state: 'indeterminada', error: e instanceof Error ? sanitizeErrorMessage(e.message, 300) : 'error' };
    }
  };
}

export function makeReconcilers(deps: PublicationDeps) {
  return {
    addRun: reconcileWrap(async (d, ctx) => {
      const t = await loadTarget(ctx.prisma, (d.payload as unknown as AddRunPayload).targetId);
      if (!t) return { state: 'indeterminada', error: 'destino inexistente' };
      if (t.trRunId) return { state: 'ya_aplicada', externalId: String(t.trRunId) };
      const found = await findExistingRun(await clientFor(deps, t), t);
      if (!found) return { state: 'no_aplicada' };
      await ctx.prisma.runTestRailTarget.update({ where: { id: t.id }, data: { trRunId: found, syncStatus: 'enviando' } });
      return { state: 'ya_aplicada', externalId: String(found) };
    }),
    addResults: reconcileWrap(async (d, ctx) => {
      const p = d.payload as unknown as AddResultsPayload;
      const t = await loadTarget(ctx.prisma, p.targetId);
      if (!t) return { state: 'indeterminada', error: 'destino inexistente' };
      if (!t.trRunId) return { state: 'no_aplicada' };
      const crs = await ctx.prisma.caseResult.findMany({
        where: { id: { in: p.caseResultIds }, trResultId: null },
        include: { case: { select: { trCaseId: true } } },
      });
      if (crs.length === 0) return { state: 'ya_aplicada' };
      const pending = crs.map((c) => ({ id: c.id, trCaseId: c.case.trCaseId }));
      const applied = await reconcileResults(await clientFor(deps, t), ctx.prisma, t, pending);
      return applied.size === pending.length ? { state: 'ya_aplicada' } : { state: 'no_aplicada' };
    }),
    attachment: reconcileWrap(async (d, ctx) => {
      const p = d.payload as unknown as AttachmentPayload;
      const t = await loadTarget(ctx.prisma, p.targetId);
      const cr = await ctx.prisma.caseResult.findUnique({ where: { id: p.caseResultId }, include: { case: { select: { trCaseId: true } } } });
      if (!t?.trRunId || !cr?.trResultId) return { state: 'no_aplicada' };
      const found = await findAttachment(await clientFor(deps, t), t.trRunId, cr.case.trCaseId, p.artifactId);
      return found ? { state: 'ya_aplicada', externalId: found } : { state: 'no_aplicada' };
    }),
    close: reconcileWrap(async (d, ctx) => {
      const t = await loadTarget(ctx.prisma, (d.payload as unknown as CloseRunPayload).targetId);
      if (!t?.trRunId) return { state: 'no_aplicada' };
      const r = await (await clientFor(deps, t)).getRun(t.trRunId);
      return r.is_completed ? { state: 'ya_aplicada', externalId: String(t.trRunId) } : { state: 'no_aplicada' };
    }),
  };
}

type Terminal = 'entregada' | 'requiere_intervencion' | 'vencida' | 'cancelada';

async function onTerminalFor(tx: Tx, d: OutboxDelivery, status: Terminal): Promise<void> {
  if (!d.targetId) return;
  const target = await tx.runTestRailTarget.findUnique({ where: { id: d.targetId } });
  if (!target) return;
  const failed = status === 'requiere_intervencion' || status === 'vencida';
  const isAttachment = d.operation === 'testrail.add_attachment_to_result';
  if (isAttachment && (failed || status === 'cancelada')) {
    // Evidencia incompleta no bloquea el cierre ni cambia el resultado (ESP §13.4).
    await tx.runTestRailTarget.update({
      where: { id: target.id },
      data: { lastError: `Evidencia incompleta: ${sanitizeErrorMessage(d.lastError ?? status, 300)}` },
    });
  } else if (failed) {
    await tx.runTestRailTarget.update({
      where: { id: target.id },
      data: { syncStatus: 'requiere_intervencion', lastError: sanitizeErrorMessage(d.lastError ?? status, 500) },
    });
    if (d.operation === 'testrail.add_results_for_cases') {
      const p = d.payload as unknown as AddResultsPayload;
      await tx.caseResult.updateMany({
        where: { id: { in: p.caseResultIds }, trResultId: null },
        data: { syncStatus: 'requiere_intervencion' },
      });
    }
  } else if (d.operation === 'testrail.close_run') {
    await tx.runTestRailTarget.update({
      where: { id: target.id },
      data: { syncStatus: target.trRunId ? 'sincronizada' : 'no_aplica' },
    });
  } else if (status === 'entregada' && target.syncStatus === 'pendiente') {
    await tx.runTestRailTarget.update({ where: { id: target.id }, data: { syncStatus: 'enviando' } });
  }
  // Corrida preexistente sin opción de cierre: sincronizada cuando no quedan entregas vivas del destino.
  if (target.existingRun && !target.closeExistingRun && (!failed || isAttachment)) {
    const fresh = await tx.runTestRailTarget.findUniqueOrThrow({ where: { id: target.id }, select: { syncStatus: true } });
    const alive = await tx.outboxDelivery.count({
      where: { targetId: target.id, id: { not: d.id }, status: { in: ['pendiente', 'en_proceso'] } },
    });
    if (alive === 0 && fresh.syncStatus !== 'requiere_intervencion') {
      await tx.runTestRailTarget.update({ where: { id: target.id }, data: { syncStatus: 'sincronizada' } });
    }
  }
  await recomputeRunSyncStatus(tx, target.runId);
}

/** Registra los handlers TestRail en el publicador genérico (proceso de control y API para reintentos). */
export function registerTestRailOutboxHandlers(deps: PublicationDeps & { secrets?: SecretProvider }): void {
  const r = makeReconcilers(deps);
  const opts = { onTerminal: onTerminalFor, timeoutMs: 120_000 };
  registerOutboxHandler('testrail.add_run', makeAddRunHandler(deps), { ...opts, reconcile: r.addRun });
  registerOutboxHandler('testrail.add_results_for_cases', makeAddResultsHandler(deps), { ...opts, reconcile: r.addResults });
  registerOutboxHandler('testrail.add_attachment_to_result', makeAttachmentHandler(deps, deps.secrets), {
    ...opts,
    reconcile: r.attachment,
  });
  registerOutboxHandler('testrail.close_run', makeCloseRunHandler(deps), { ...opts, reconcile: r.close });
}
