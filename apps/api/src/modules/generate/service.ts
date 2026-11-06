/**
 * Generación asistida por IA (RF-GRB-03) y revisión asistida de grabaciones (RF-GRB-04); ESP §10, §13.7, §11 B3.
 * - Proveedor por interfaz `AiProvider` (Anthropic por defecto `claude-opus-5-5`, configurable; fake en pruebas).
 * - Presupuesto: por solicitud (tope de tokens de salida derivado), por usuario/día y mensual; reserva serializada
 *   con advisory lock y registro en `generation_request` (modelo, versión de prompt, tokens, costo).
 * - Entradas como datos no confiables y sanitizadas; sin herramientas; timeout.
 * - Salida: borrador en una rama `katalyst/...` + PR borrador vía `GitPrProvider`; NUNCA en la rama principal ni se
 *   ejecuta. El código pasa por el análisis estático (secretos ⇒ se descarta).
 */
import { Prisma, type GenerationRequest, type PrismaClient } from '@prisma/client';
import { KatalystError, lintTestSource, verifySanitized } from '@katalyst/shared';
import type { Config } from '../../config.js';
import { AiProviderError, estimateInputTokens, costUsd, type AiProvider } from '../../adapters/ai/index.js';
import { GitProviderError, type GitPrProvider } from '../../adapters/git-pr/index.js';
import { recordAudit } from '../../lib/audit.js';
import { isAdmin, type Principal } from '../../lib/auth.js';
import { buildRecordedTestFile, buildTitle, normalizeTags, recordingFilePath, slugCaseRef } from '../recordings/codegen.js';
import { manifestWithEntry, MANIFEST_FILE_NAME } from '../recordings/manifest-edit.js';
import { actorUserId, stableKeyFor } from '../recordings/service.js';
import { apiCSettings } from '../recordings/settings.js';
import {
  buildGeneratePrompt,
  buildReviewPrompt,
  cleanUntrusted,
  extractCode,
  GENERATE_PROMPT_VERSION,
  REVIEW_PROMPT_VERSION,
  suspiciousConstructs,
} from './prompt.js';
import { deterministicReview, preservesPublicExceptions } from './review.js';

export interface GenerateDeps {
  config: Config;
  ai: AiProvider | null;
  git: GitPrProvider | null;
  now?: () => Date;
}

export interface GenerationResult {
  code: string;
  todos: number;
  changes: string[];
  needsHumanReview: string[];
  branch: string | null;
  prUrl: string | null;
  file: string | null;
}

export function toGenerationDto(g: GenerationRequest) {
  const result = (g.result ?? null) as GenerationResult | null;
  return {
    id: g.id,
    kind: g.kind,
    status: g.status,
    caseId: g.caseId,
    recordingId: g.recordingId,
    provider: g.provider,
    model: g.model,
    promptVersion: g.promptVersion,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    costUsd: g.costUsd === null ? null : Number(g.costUsd),
    result: result
      ? {
          code: result.code,
          todos: result.todos,
          changes: result.changes,
          needsHumanReview: result.needsHumanReview,
          branch: result.branch ?? null,
          prUrl: result.prUrl ?? null,
          file: result.file ?? null,
        }
      : null,
    error: g.error,
    createdBy: g.createdById,
    createdAt: g.createdAt.toISOString(),
    finishedAt: g.finishedAt ? g.finishedAt.toISOString() : null,
  };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export interface Reservation {
  id: string;
  maxOutputTokens: number;
  reservedUsd: number;
}

/**
 * Reserva presupuesto y crea la solicitud `en_proceso` (o `rechazado_presupuesto` + AI_BUDGET_EXCEEDED).
 * Serializada con `pg_advisory_xact_lock` para que solicitudes concurrentes no superen los topes.
 */
export async function reserveBudget(
  prisma: PrismaClient,
  deps: GenerateDeps,
  ai: AiProvider,
  input: { kind: 'borrador_desde_caso' | 'revision_grabacion'; userId: string; caseId: string | null; recordingId: string | null; promptVersion: string; promptChars: string },
): Promise<Reservation> {
  const now = deps.now?.() ?? new Date();
  const s = apiCSettings();
  const inputTokens = estimateInputTokens(input.promptChars);
  const inputCost = (inputTokens * ai.pricing.inputPerMTok) / 1_000_000;
  const perRequest = deps.config.AI_BUDGET_USD_PER_REQUEST;
  const affordable = Math.floor(((perRequest - inputCost) * 1_000_000) / ai.pricing.outputPerMTok);
  const maxOutputTokens = Math.min(s.AI_MAX_OUTPUT_TOKENS, affordable);
  const reservedUsd = Math.round((inputCost + (Math.max(maxOutputTokens, 0) * ai.pricing.outputPerMTok) / 1_000_000) * 1e6) / 1e6;
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('katalyst:ai-budget'))`;
    const [day, month] = await Promise.all([
      tx.generationRequest.aggregate({
        _sum: { costUsd: true },
        where: { createdById: input.userId, createdAt: { gte: startOfUtcDay(now) }, status: { not: 'rechazado_presupuesto' } },
      }),
      tx.generationRequest.aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: startOfUtcMonth(now) }, status: { not: 'rechazado_presupuesto' } },
      }),
    ]);
    const spentDay = Number(day._sum.costUsd ?? 0);
    const spentMonth = Number(month._sum.costUsd ?? 0);
    let reason: string | null = null;
    if (maxOutputTokens < 1024) reason = 'presupuesto_por_solicitud';
    else if (spentDay + reservedUsd > deps.config.AI_BUDGET_USD_PER_USER_DAY) reason = 'presupuesto_usuario_dia';
    else if (spentMonth + reservedUsd > deps.config.AI_BUDGET_USD_PER_MONTH) reason = 'presupuesto_mensual';
    const g = await tx.generationRequest.create({
      data: {
        kind: input.kind,
        status: reason ? 'rechazado_presupuesto' : 'en_proceso',
        caseId: input.caseId,
        recordingId: input.recordingId,
        provider: ai.name,
        model: ai.model,
        promptVersion: input.promptVersion,
        createdById: input.userId,
        // Reserva: costo máximo; se reemplaza por el real al terminar.
        costUsd: reason ? 0 : new Prisma.Decimal(reservedUsd),
        error: reason,
        finishedAt: reason ? now : null,
      },
    });
    return { g, reason };
  });
  if (outcome.reason) throw new KatalystError('AI_BUDGET_EXCEEDED', undefined, { reasons: [outcome.reason] });
  return { id: outcome.g.id, maxOutputTokens, reservedUsd };
}

async function failGeneration(prisma: PrismaClient, id: string, error: string, usage?: { input: number; output: number; cost: number }) {
  await prisma.generationRequest.update({
    where: { id },
    data: {
      status: 'fallido',
      error,
      finishedAt: new Date(),
      ...(usage
        ? { inputTokens: usage.input, outputTokens: usage.output, costUsd: new Prisma.Decimal(usage.cost) }
        : { costUsd: new Prisma.Decimal(0) }),
    },
  });
}

function aiErrorToKatalyst(e: AiProviderError): KatalystError {
  return new KatalystError('AI_PROVIDER_UNAVAILABLE', undefined, { reasons: [e.kind] });
}

/** `POST /generate {caseId}`: borrador desde los pasos del caso de TestRail. */
export async function generateFromCase(prisma: PrismaClient, deps: GenerateDeps, actor: Principal, caseId: string, requestId?: string) {
  if (!deps.ai) throw new KatalystError('AI_DISABLED');
  const ai = deps.ai;
  const s = apiCSettings();
  const userId = await actorUserId(prisma, actor);
  const tcase = await prisma.testRailCase.findUnique({ where: { id: caseId } });
  if (!tcase) throw new KatalystError('NOT_FOUND', 'Caso inexistente.');
  if (tcase.archivedAt) throw new KatalystError('CASE_ARCHIVED');
  const caseRef = `C${tcase.trCaseId}`;
  const tags = normalizeTags(['@borrador_ia']);
  // El título del caso también es dato no confiable (sin HTML ni secretos).
  const safeTitle = cleanUntrusted(tcase.title, 200);
  const testTitle = buildTitle(caseRef, safeTitle, tags);
  const prompt = buildGeneratePrompt({ caseRef, title: tcase.title, steps: tcase.steps, expected: tcase.expected, testTitle });
  const reservation = await reserveBudget(prisma, deps, ai, {
    kind: 'borrador_desde_caso',
    userId,
    caseId,
    recordingId: null,
    promptVersion: GENERATE_PROMPT_VERSION,
    promptChars: prompt.system + prompt.user,
  });
  await prisma.$transaction((tx) =>
    recordAudit(tx, {
      actor,
      action: 'generation.create',
      entity: 'generation_request',
      entityId: reservation.id,
      diff: { kind: 'borrador_desde_caso', caseId, model: ai.model, promptVersion: GENERATE_PROMPT_VERSION },
      ...(requestId ? { requestId } : {}),
    }),
  );
  let completion;
  try {
    completion = await ai.complete({
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: reservation.maxOutputTokens,
      timeoutMs: deps.config.AI_TIMEOUT_MS,
    });
  } catch (e) {
    const err = e instanceof AiProviderError ? e : new AiProviderError('unavailable', 'Error del proveedor');
    await failGeneration(prisma, reservation.id, `proveedor:${err.kind}`);
    throw aiErrorToKatalyst(err);
  }
  const usage = {
    input: completion.usage.inputTokens + completion.usage.cacheReadInputTokens + completion.usage.cacheCreationInputTokens,
    output: completion.usage.outputTokens,
    cost: costUsd(completion.usage, ai.pricing),
  };
  const raw = extractCode(completion.text);
  // Nunca persistir/publicar salida con secretos (p. ej. si los pasos tenían datos sensibles residuales).
  if (!verifySanitized(raw).ok) {
    await failGeneration(prisma, reservation.id, 'salida_con_posibles_secretos', usage);
    throw new KatalystError('SECRET_DETECTED', 'La salida de la IA contenía posibles secretos y se descartó.');
  }
  const genKey = stableKeyFor(`ia:${reservation.id}`);
  const built = buildRecordedTestFile({
    code: raw,
    caseRef,
    titleText: safeTitle,
    tags,
    stableKey: genKey,
    recordingId: `ia-${reservation.id}`,
    fixtureImport: s.QA_TESTS_FIXTURE_IMPORT,
  });
  const content = built.content.replace('test grabado con el asistente local de Katalyst (sesión', 'borrador generado con IA (solicitud');
  const lint = lintTestSource(content);
  const todos = (content.match(/TODO\s*(?:selector|verificaci[oó]n)/gi) ?? []).length;
  const needsHumanReview = [
    ...lint.issues.map((i) => `${i.code}${i.line ? ` (línea ${i.line})` : ''}: ${i.message}`),
    ...suspiciousConstructs(content).map((x) => `Construcción no permitida en tests: ${x}`),
    'Revisar y aprobar en el PR borrador: la IA no ejecuta ni valida el test.',
  ];
  const result: GenerationResult = {
    code: content,
    todos,
    changes: built.issues.map((i) => i.message),
    needsHumanReview,
    branch: null,
    prUrl: null,
    file: null,
  };
  // Borrador en rama nueva + PR borrador (nunca la rama principal).
  if (deps.git) {
    const shortId = reservation.id.slice(0, 8);
    const file = recordingFilePath(s.AI_DRAFTS_DIR, caseRef, reservation.id);
    try {
      const manifest = await manifestWithEntry(deps.git, deps.config.GIT_PROTECTED_BRANCH, {
        stableKey: genKey,
        file,
        title: built.title,
        cases: [caseRef],
        tags,
        classification: 'sin_clasificar',
        parameterKeys: ['default'],
        writeIdempotencyApproved: false,
        owner: 'ia-borrador',
        status: 'aprobado',
      });
      const change = await deps.git.openChange({
        baseBranch: deps.config.GIT_PROTECTED_BRANCH,
        branch: `katalyst/ia/${slugCaseRef(caseRef)}-${shortId}`,
        commitMessage: `test(${caseRef}): borrador IA ${shortId} (${ai.model}, ${GENERATE_PROMPT_VERSION})`,
        files: [
          { path: file, content },
          { path: MANIFEST_FILE_NAME, content: manifest },
        ],
        title: `${caseRef} · borrador IA ${shortId} (no ejecutado, requiere revisión)`,
        body: [
          `Borrador generado con IA para **${caseRef}** (modelo \`${ai.model}\`, prompt \`${GENERATE_PROMPT_VERSION}\`, solicitud \`${reservation.id}\`).`,
          '',
          'No fue ejecutado. Debe revisarse según ESP §10 antes de aprobar; el manifiesto queda `sin_clasificar`.',
          '',
          '### Necesita revisión humana',
          ...needsHumanReview.map((x) => `- ${x}`),
        ].join('\n'),
        draft: true,
      });
      result.branch = change.branch;
      result.prUrl = change.url;
      result.file = file;
    } catch (e) {
      if (!(e instanceof GitProviderError)) throw e;
      result.needsHumanReview.push('No se pudo abrir el PR borrador (plataforma Git no disponible); el código queda en esta solicitud.');
    }
  } else {
    result.needsHumanReview.push('Sin plataforma Git configurada: el borrador no se publicó en una rama.');
  }
  const g = await prisma.generationRequest.update({
    where: { id: reservation.id },
    data: {
      status: 'listo',
      inputTokens: usage.input,
      outputTokens: usage.output,
      costUsd: new Prisma.Decimal(usage.cost),
      result: result as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
    },
  });
  return toGenerationDto(g);
}

/** `POST /generate/review {recordingId}`: revisión asistida de la grabación en su rama de PR. */
export async function reviewRecording(prisma: PrismaClient, deps: GenerateDeps, actor: Principal, recordingId: string, requestId?: string) {
  const s = apiCSettings();
  const userId = await actorUserId(prisma, actor);
  const rec = await prisma.recordingSession.findUnique({ where: { id: recordingId }, include: { case: { select: { trCaseId: true } } } });
  if (!rec) throw new KatalystError('NOT_FOUND');
  if (rec.status !== 'pr_abierto' || !rec.branch) throw new KatalystError('RECORDING_INVALID_STATE', 'La grabación no tiene un PR abierto.');
  if (!deps.git) throw new KatalystError('GIT_PROVIDER_UNAVAILABLE', 'No hay una plataforma Git configurada.');
  const caseRef = `C${rec.case.trCaseId}`;
  const file = recordingFilePath(s.RECORDING_TESTS_DIR, caseRef, rec.id);
  let original: string | null;
  try {
    original = await deps.git.readFile(rec.branch, file);
  } catch {
    throw new KatalystError('GIT_PROVIDER_UNAVAILABLE');
  }
  if (original === null) throw new KatalystError('NOT_FOUND', 'El archivo de la grabación no existe en la rama.');
  const det = deterministicReview(original);
  let finalCode = det.code;
  const changes = [...det.changes];
  const needs = [...det.needsHumanReview];
  const ai = deps.ai;
  const provider = ai?.name ?? 'determinista';
  const model = ai?.model ?? 'reglas-esp-10';
  let usage = { input: 0, output: 0, cost: 0 };
  let generationId: string;
  if (ai) {
    const prompt = buildReviewPrompt(det.code, caseRef);
    const reservation = await reserveBudget(prisma, deps, ai, {
      kind: 'revision_grabacion',
      userId,
      caseId: rec.caseId,
      recordingId: rec.id,
      promptVersion: REVIEW_PROMPT_VERSION,
      promptChars: prompt.system + prompt.user,
    });
    generationId = reservation.id;
    try {
      const completion = await ai.complete({ ...prompt, maxOutputTokens: reservation.maxOutputTokens, timeoutMs: deps.config.AI_TIMEOUT_MS });
      usage = {
        input: completion.usage.inputTokens + completion.usage.cacheReadInputTokens + completion.usage.cacheCreationInputTokens,
        output: completion.usage.outputTokens,
        cost: costUsd(completion.usage, ai.pricing),
      };
      const candidate = extractCode(completion.text);
      const keyLine = /stableKey\('([0-9a-f-]{36})'\)/.exec(det.code)?.[0];
      const problems: string[] = [];
      if (!verifySanitized(candidate).ok) problems.push('la salida contenía posibles secretos');
      if (!preservesPublicExceptions(det.code, candidate)) problems.push('eliminaba excepciones públicas de MUI/Inovua');
      if (keyLine && !candidate.includes(keyLine)) problems.push('modificaba la anotación stableKey');
      if (/\bwaitForTimeout\s*\(/.test(candidate)) problems.push('mantenía esperas fijas');
      if (suspiciousConstructs(candidate).length) problems.push(`introducía construcciones no permitidas (${suspiciousConstructs(candidate).join(', ')})`);
      if (problems.length === 0 && candidate.length > 0) {
        finalCode = `${candidate}\n`;
        changes.push('Pasada IA: selectores/esperas/datos/verificaciones revisados según ESP §10');
      } else {
        needs.push(`Se descartó la propuesta de la IA porque ${problems.join('; ') || 'estaba vacía'}; se conservó la revisión determinista`);
      }
    } catch (e) {
      const err = e instanceof AiProviderError ? e : new AiProviderError('unavailable', 'Error del proveedor');
      await failGeneration(prisma, reservation.id, `proveedor:${err.kind}`);
      throw aiErrorToKatalyst(err);
    }
  } else {
    const g = await prisma.generationRequest.create({
      data: {
        kind: 'revision_grabacion',
        status: 'en_proceso',
        caseId: rec.caseId,
        recordingId: rec.id,
        provider,
        model,
        promptVersion: REVIEW_PROMPT_VERSION,
        createdById: userId,
        costUsd: new Prisma.Decimal(0),
      },
    });
    generationId = g.id;
  }
  const lint = lintTestSource(finalCode);
  for (const i of lint.issues) needs.push(`${i.code}${i.line ? ` (línea ${i.line})` : ''}: ${i.message}`);
  let commit: string | null = null;
  if (finalCode !== original) {
    try {
      commit = (
        await deps.git.pushToBranch({
          branch: rec.branch,
          commitMessage: `test(${caseRef}): revisión asistida (${provider}, ${REVIEW_PROMPT_VERSION})`,
          files: [{ path: file, content: finalCode }],
        })
      ).commit;
    } catch {
      await failGeneration(prisma, generationId, 'git_no_disponible', usage);
      throw new KatalystError('GIT_PROVIDER_UNAVAILABLE');
    }
  }
  const result: GenerationResult = {
    code: finalCode,
    todos: (finalCode.match(/TODO\s*(?:selector|verificaci[oó]n)/gi) ?? []).length,
    changes: commit ? [...changes, `Commit ${commit.slice(0, 12)} en ${rec.branch}`] : changes,
    needsHumanReview: [...new Set(needs)],
    branch: rec.branch,
    prUrl: rec.prUrl,
    file,
  };
  const g = await prisma.$transaction(async (tx) => {
    const updated = await tx.generationRequest.update({
      where: { id: generationId },
      data: {
        status: 'listo',
        inputTokens: usage.input,
        outputTokens: usage.output,
        costUsd: new Prisma.Decimal(usage.cost),
        result: result as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
    await recordAudit(tx, {
      actor,
      action: 'generation.create',
      entity: 'generation_request',
      entityId: generationId,
      diff: { kind: 'revision_grabacion', recordingId, model, promptVersion: REVIEW_PROMPT_VERSION, commit },
      ...(requestId ? { requestId } : {}),
    });
    return updated;
  });
  return toGenerationDto(g);
}

export async function getGeneration(prisma: PrismaClient, actor: Principal, id: string) {
  const g = await prisma.generationRequest.findUnique({ where: { id } });
  if (!g) throw new KatalystError('NOT_FOUND');
  if (!isAdmin(actor) && g.createdById !== (await actorUserId(prisma, actor))) throw new KatalystError('NOT_FOUND');
  return toGenerationDto(g);
}

