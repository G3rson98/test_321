/**
 * Sesiones de grabación (RF-GRB-01, RF-GRB-02, RF-GRB-05, RF-GRB-06; ESP §9 2C, §13.6).
 * - Crear: caso vigente, ambiente habilitado, NO producción y con grabación permitida; vence a las 2 h; responde ID,
 *   vencimiento y enlace `katalyst://grabar?session=<id>` (solo el ID: sin credenciales ni storageState).
 * - Estados `creada → vinculada → grabando → validando → pr_abierto | rechazada`, `cancelada`, `vencida`;
 *   transiciones idempotentes; cada grabación pertenece a su creador (admin puede verla).
 * - Completar: análisis estático (sin ejecutar ni instalar nada), archivo y entrada de manifiesto generados por el
 *   servidor, rama nueva y PR/MR (borrador si hay advertencias). El catálogo NO incorpora el archivo hasta que el
 *   PR se apruebe y fusione en la rama protegida (lo hace el refresco del catálogo).
 * - El código NO se persiste en el backend (va directo a la rama del PR); los secretos detectados se rechazan sin
 *   reflejarlos en mensajes ni logs.
 */
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, RecordingSession } from '@prisma/client';
import {
  KatalystError,
  RECORDING_MAX_CODE_BYTES,
  RECORDING_TTL_MS,
  TERMINAL_RECORDING_STATUSES,
  type RecordingComplete,
  type RecordingStatus,
} from '@katalyst/shared';
import type { Config } from '../../config.js';
import { GitProviderError, type GitPrProvider } from '../../adapters/git-pr/index.js';
import { recordAudit } from '../../lib/audit.js';
import { isAdmin, type Principal } from '../../lib/auth.js';
import { decodePageCursor, keysetOrderBy, keysetWhere, paginate, parseSort } from '../../lib/pagination.js';
import { deviceStatus } from '../devices/service.js';
import { analyzeRecording, normalizeTags, recordingBranch, recordingFilePath, type RecordingIssue } from './codegen.js';
import { manifestWithEntry, MANIFEST_FILE_NAME } from './manifest-edit.js';
import { apiCSettings } from './settings.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const ASSISTANT_LINK_PREFIX = 'katalyst://grabar?session=';
const TERMINAL = new Set<RecordingStatus>(TERMINAL_RECORDING_STATUSES);

/** Transiciones permitidas (además de la identidad, que es idempotente). */
export const RECORDING_TRANSITIONS: Record<RecordingStatus, readonly RecordingStatus[]> = {
  creada: ['vinculada', 'grabando', 'validando', 'cancelada', 'vencida'],
  vinculada: ['grabando', 'validando', 'cancelada', 'vencida'],
  grabando: ['vinculada', 'validando', 'cancelada', 'vencida'],
  validando: ['pr_abierto', 'rechazada', 'grabando', 'vinculada', 'cancelada', 'vencida'],
  pr_abierto: [],
  rechazada: [],
  cancelada: [],
  vencida: [],
};

export function canTransition(from: RecordingStatus, to: RecordingStatus): boolean {
  return from === to || RECORDING_TRANSITIONS[from].includes(to);
}

/** `stableKey` determinista por grabación (UUID v4 válido): reintentos producen la misma entrada de manifiesto. */
export function stableKeyFor(recordingId: string): string {
  const h = createHash('sha256').update(`katalyst-recording:${recordingId}`).digest('hex').split('');
  h[12] = '4';
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Usuario del panel detrás del principal (tokens API: su dueño). */
export async function actorUserId(db: Db, p: Principal): Promise<string> {
  if (p.kind === 'panel_user') return p.id;
  if (p.kind === 'device') return p.userId;
  if (p.kind === 'api_token') {
    const c = await db.apiCredential.findUnique({ where: { id: p.id }, select: { principalId: true } });
    if (c?.principalId) return c.principalId;
  }
  throw new KatalystError('FORBIDDEN');
}

type SessionWithRefs = RecordingSession & {
  case: { trCaseId: number };
  environment: { id: string; name: string; appUrl: string; isProduction: boolean; recordingAllowed: boolean; enabled: boolean; disabledAt: Date | null };
};

const include = {
  case: { select: { trCaseId: true } },
  environment: {
    select: { id: true, name: true, appUrl: true, isProduction: true, recordingAllowed: true, enabled: true, disabledAt: true },
  },
} as const;

export function toRecordingDto(r: SessionWithRefs) {
  return {
    id: r.id,
    caseId: r.caseId,
    caseRef: `C${r.case.trCaseId}`,
    environmentId: r.environmentId,
    createdBy: r.createdById,
    deviceId: r.deviceId,
    status: r.status,
    tags: r.tags,
    expiresAt: r.expiresAt.toISOString(),
    branch: r.branch,
    prUrl: r.prUrl,
    commit: r.commit,
    rejectionReasons: (r.rejectionReasons ?? []) as { code: string; message: string; line: number | null }[],
    steps: (r.steps ?? []) as { kind: 'accion' | 'verificacion' | 'no_soportada'; description: string }[],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    /** Extensión para el asistente (contrato RECORDER): datos del ambiente para iniciar el login local. */
    environment: {
      id: r.environment.id,
      name: r.environment.name,
      appUrl: r.environment.appUrl,
      isProduction: r.environment.isProduction,
      recordingAllowed: r.environment.recordingAllowed && !r.environment.isProduction,
      enabled: r.environment.enabled && !r.environment.disabledAt,
    },
  };
}

/** Carga con autorización por recurso (dueño o admin; si no, 404) y vencimiento perezoso. */
async function loadOwned(db: Db, actor: Principal, id: string, now = new Date()): Promise<SessionWithRefs> {
  const r = await db.recordingSession.findUnique({ where: { id }, include });
  if (!r) throw new KatalystError('NOT_FOUND');
  if (!isAdmin(actor)) {
    const uid = await actorUserId(db, actor);
    if (r.createdById !== uid) throw new KatalystError('NOT_FOUND');
  }
  if (!TERMINAL.has(r.status) && r.expiresAt <= now) {
    await db.recordingSession.updateMany({ where: { id, status: r.status }, data: { status: 'vencida' } });
    return { ...r, status: 'vencida' };
  }
  return r;
}

export async function createRecording(
  prisma: PrismaClient,
  actor: Principal,
  input: { caseId: string; environmentId: string; tags: string[] },
  requestId?: string,
  now = new Date(),
) {
  const created = await prisma.$transaction(async (tx) => {
    const userId = await actorUserId(tx, actor);
    const tcase = await tx.testRailCase.findUnique({ where: { id: input.caseId }, select: { id: true, archivedAt: true } });
    if (!tcase) throw new KatalystError('NOT_FOUND', 'Caso inexistente.');
    if (tcase.archivedAt) throw new KatalystError('CASE_ARCHIVED');
    const env = await tx.environment.findUnique({ where: { id: input.environmentId } });
    if (!env) throw new KatalystError('NOT_FOUND', 'Ambiente inexistente.');
    if (!env.enabled || env.disabledAt) throw new KatalystError('ENVIRONMENT_DISABLED');
    // ESP §13.6: no se permite grabación en producción; además el ambiente debe permitir grabar.
    if (env.isProduction || !env.recordingAllowed) throw new KatalystError('RECORDING_PRODUCTION_BLOCKED');
    const r = await tx.recordingSession.create({
      data: {
        caseId: input.caseId,
        environmentId: input.environmentId,
        createdById: userId,
        deviceId: actor.kind === 'device' ? actor.id : null,
        tags: normalizeTags(input.tags),
        expiresAt: new Date(now.getTime() + RECORDING_TTL_MS),
      },
      include,
    });
    await recordAudit(tx, {
      actor,
      action: 'recording.create',
      entity: 'recording_session',
      entityId: r.id,
      diff: { caseId: input.caseId, environmentId: input.environmentId, tags: r.tags },
      ...(requestId ? { requestId } : {}),
    });
    return { r, userId };
  });
  return {
    recording: toRecordingDto(created.r),
    assistantLink: `${ASSISTANT_LINK_PREFIX}${created.r.id}`,
    assistant: await deviceStatus(prisma, created.userId, now).then((s) => ({
      linked: s.linked,
      online: s.online,
      installUrl: s.installUrl,
    })),
  };
}

export async function getRecording(prisma: PrismaClient, actor: Principal, id: string) {
  return toRecordingDto(await loadOwned(prisma, actor, id));
}

export async function listRecordings(
  prisma: PrismaClient,
  actor: Principal,
  q: { status?: RecordingStatus | undefined; caseId?: string | undefined; limit: number; cursor?: string | undefined },
) {
  const sort = parseSort('-createdAt', { createdAt: 'date' });
  const after = decodePageCursor(q.cursor, sort);
  const owner = isAdmin(actor) ? {} : { createdById: await actorUserId(prisma, actor) };
  const rows = await prisma.recordingSession.findMany({
    where: {
      AND: [owner, q.status ? { status: q.status } : {}, q.caseId ? { caseId: q.caseId } : {}, keysetWhere(sort, after)],
    },
    orderBy: keysetOrderBy(sort),
    take: q.limit + 1,
    include,
  });
  const page = paginate(rows, q.limit, sort);
  return { ...page, items: page.items.map(toRecordingDto) };
}

/** `POST /recordings/:id/status` (asistente): `vinculada | grabando | validando`, idempotente. */
export async function updateRecordingStatus(
  prisma: PrismaClient,
  actor: Principal,
  id: string,
  input: { status: 'vinculada' | 'grabando' | 'validando'; steps?: { kind: 'accion' | 'verificacion' | 'no_soportada'; description: string }[] | undefined },
) {
  return prisma.$transaction(async (tx) => {
    const r = await loadOwned(tx, actor, id);
    if (r.status === 'vencida') throw new KatalystError('RECORDING_EXPIRED');
    if (!canTransition(r.status, input.status)) throw new KatalystError('RECORDING_INVALID_STATE');
    const upd = await tx.recordingSession.updateMany({
      where: { id, status: r.status },
      data: {
        status: input.status,
        ...(actor.kind === 'device' && !r.deviceId ? { deviceId: actor.id } : {}),
        ...(input.steps ? { steps: input.steps } : {}),
      },
    });
    if (upd.count !== 1) throw new KatalystError('RECORDING_INVALID_STATE');
    return toRecordingDto(await tx.recordingSession.findUniqueOrThrow({ where: { id }, include }));
  });
}

export async function cancelRecording(prisma: PrismaClient, actor: Principal, id: string, reason?: string, requestId?: string) {
  return prisma.$transaction(async (tx) => {
    const r = await loadOwned(tx, actor, id);
    if (r.status === 'cancelada') return toRecordingDto(r);
    if (!canTransition(r.status, 'cancelada')) throw new KatalystError('RECORDING_INVALID_STATE');
    const upd = await tx.recordingSession.updateMany({ where: { id, status: r.status }, data: { status: 'cancelada' } });
    if (upd.count !== 1) throw new KatalystError('RECORDING_INVALID_STATE');
    await recordAudit(tx, {
      actor,
      action: 'recording.cancel',
      entity: 'recording_session',
      entityId: id,
      diff: { from: r.status, reason: reason ?? null },
      ...(requestId ? { requestId } : {}),
    });
    return toRecordingDto(await tx.recordingSession.findUniqueOrThrow({ where: { id }, include }));
  });
}

function issuesJson(issues: RecordingIssue[]) {
  return issues.slice(0, 200).map((i) => ({ code: i.code, message: i.message, line: i.line }));
}

function prBody(p: {
  caseRef: string;
  recordingId: string;
  environmentName: string;
  tags: string[];
  suggested: string;
  file: string;
  steps: { kind: string; description: string }[];
  warnings: RecordingIssue[];
}): string {
  const lines = [
    `Grabación del caso **${p.caseRef}** con el asistente local de Katalyst (sesión \`${p.recordingId}\`).`,
    '',
    `- Ambiente de grabación: ${p.environmentName}`,
    `- Archivo: \`${p.file}\``,
    `- Etiquetas: ${p.tags.length ? p.tags.join(' ') : '(ninguna)'}`,
    `- Clasificación sugerida por QA: \`${p.suggested}\` (el manifiesto queda \`sin_clasificar\` hasta que el developer la confirme)`,
    '',
    '### Antes de aprobar (ESP §10, RF-GRB-05)',
    '- [ ] Refactorizar selectores a Page Objects (`pages/`) y usar el orden testId → role → label → text.',
    '- [ ] Completar las verificaciones del resultado esperado del caso.',
    '- [ ] Clasificar el test (`lectura` / `escritura`) en `katalyst.manifest.json`.',
    '- [ ] Confirmar que no hay datos reales de clientes ni credenciales.',
  ];
  if (p.warnings.length) {
    lines.push('', '### Hallazgos que bloquean la aprobación');
    for (const w of p.warnings) lines.push(`- \`${w.code}\`${w.line ? ` (línea ${w.line})` : ''}: ${w.message}`);
  }
  if (p.steps.length) {
    lines.push('', '### Pasos reconocidos por el asistente');
    for (const s of p.steps.slice(0, 100)) lines.push(`- [${s.kind}] ${s.description.replace(/[\r\n]+/g, ' ')}`);
  }
  lines.push('', '_Este PR no se fusiona automáticamente; el catálogo lo incorpora solo tras aprobarlo y fusionarlo._');
  return lines.join('\n');
}

export interface CompleteDeps {
  config: Config;
  git: GitPrProvider | null;
}

/** `POST /recordings/:id/complete`. */
export async function completeRecording(
  prisma: PrismaClient,
  deps: CompleteDeps,
  actor: Principal,
  id: string,
  body: RecordingComplete,
  requestId?: string,
): Promise<ReturnType<typeof toRecordingDto>> {
  const s = apiCSettings();
  if (Buffer.byteLength(body.code, 'utf8') > RECORDING_MAX_CODE_BYTES) throw new KatalystError('RECORDING_TOO_LARGE');
  // 1) Reserva idempotente: creada|vinculada|grabando → validando.
  const start = await prisma.$transaction(async (tx) => {
    const r = await loadOwned(tx, actor, id);
    if (r.status === 'pr_abierto') return { kind: 'done', done: toRecordingDto(r) } as const;
    if (r.status === 'vencida') throw new KatalystError('RECORDING_EXPIRED');
    if (!['creada', 'vinculada', 'grabando'].includes(r.status)) throw new KatalystError('RECORDING_INVALID_STATE');
    const upd = await tx.recordingSession.updateMany({ where: { id, status: r.status }, data: { status: 'validando' } });
    if (upd.count !== 1) throw new KatalystError('RECORDING_INVALID_STATE');
    return { kind: 'start', session: r, previous: r.status } as const;
  });
  if (start.kind === 'done') return start.done;
  const r = start.session;
  const caseRef = `C${r.case.trCaseId}`;
  const tags = normalizeTags(r.tags, body.tags);
  const stableKey = stableKeyFor(r.id);
  const file = recordingFilePath(s.RECORDING_TESTS_DIR, caseRef, r.id);
  const analysis = analyzeRecording({
    code: body.code,
    caseRef,
    titleText: body.title,
    tags,
    stableKey,
    recordingId: r.id,
    fixtureImport: s.QA_TESTS_FIXTURE_IMPORT,
    metadata: [body.title, ...body.tags, ...body.steps.map((x) => x.description)],
    pendingVerifications: body.pendingVerifications,
    unsupportedSteps: body.steps.filter((x) => x.kind === 'no_soportada').length,
  });

  const finish = async (data: Prisma.RecordingSessionUpdateManyMutationInput, audit: Record<string, unknown>) => {
    await prisma.$transaction(async (tx) => {
      await tx.recordingSession.updateMany({ where: { id, status: 'validando' }, data });
      await recordAudit(tx, {
        actor,
        action: 'recording.complete',
        entity: 'recording_session',
        entityId: id,
        diff: audit,
        ...(requestId ? { requestId } : {}),
      });
    });
  };

  if (analysis.rejections.length > 0) {
    const reasons = issuesJson([...analysis.rejections, ...analysis.warnings]);
    await finish({ status: 'rechazada', rejectionReasons: reasons, steps: body.steps }, {
      result: 'rechazada',
      codes: [...new Set(analysis.rejections.map((i) => i.code))],
    });
    const secret = analysis.rejections.some((i) => ['SECRET_DETECTED', 'HARDCODED_CREDENTIALS', 'METADATA_SECRET'].includes(i.code));
    throw new KatalystError(secret ? 'SECRET_DETECTED' : 'RECORDING_REJECTED', undefined, {
      reasons: analysis.rejections.map((i) => i.code),
      issues: [],
    });
  }

  // 2) Rama + PR (sin escribir en la rama protegida).
  const revert = async () => {
    await prisma.recordingSession.updateMany({ where: { id, status: 'validando' }, data: { status: start.previous } });
  };
  if (!deps.git) {
    await revert();
    throw new KatalystError('GIT_PROVIDER_UNAVAILABLE', 'No hay una plataforma Git configurada para abrir el PR.');
  }
  const branch = recordingBranch(caseRef, r.id);
  let change;
  try {
    const manifest = await manifestWithEntry(deps.git, deps.config.GIT_PROTECTED_BRANCH, {
      stableKey,
      file,
      title: analysis.title,
      cases: [caseRef],
      tags,
      classification: 'sin_clasificar',
      parameterKeys: ['default'],
      writeIdempotencyApproved: false,
      owner: 'qa-grabacion',
      status: 'aprobado',
    });
    change = await deps.git.openChange({
      baseBranch: deps.config.GIT_PROTECTED_BRANCH,
      branch,
      commitMessage: `test(${caseRef}): grabación ${r.id.slice(0, 8)} desde Katalyst`,
      files: [
        { path: file, content: analysis.content },
        { path: MANIFEST_FILE_NAME, content: manifest },
      ],
      title: `${caseRef} · grabación ${r.id.slice(0, 8)} (pendiente de revisión)`,
      body: prBody({
        caseRef,
        recordingId: r.id,
        environmentName: r.environment.name,
        tags,
        suggested: body.classification,
        file,
        steps: body.steps,
        warnings: analysis.warnings,
      }),
      draft: analysis.warnings.length > 0,
    });
  } catch (err) {
    await revert();
    if (err instanceof GitProviderError) throw new KatalystError('GIT_PROVIDER_UNAVAILABLE');
    throw err;
  }
  await finish(
    {
      status: 'pr_abierto',
      branch: change.branch,
      prUrl: change.url,
      commit: change.commit,
      rejectionReasons: issuesJson(analysis.warnings),
      steps: body.steps,
    },
    { result: 'pr_abierto', branch: change.branch, prUrl: change.url, warnings: analysis.warnings.map((w) => w.code) },
  );
  return toRecordingDto(await prisma.recordingSession.findUniqueOrThrow({ where: { id }, include }));
}

/** Vence sesiones no terminales con más de 2 h (tarea periódica). */
export async function expireRecordingSessions(prisma: PrismaClient, now = new Date()): Promise<number> {
  const r = await prisma.recordingSession.updateMany({
    where: { status: { in: ['creada', 'vinculada', 'grabando', 'validando'] }, expiresAt: { lte: now } },
    data: { status: 'vencida' },
  });
  return r.count;
}
