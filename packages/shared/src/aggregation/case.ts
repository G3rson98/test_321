/**
 * Agregación por caso (ESP §13.4) y mapeo a TestRail (ESP §8).
 *
 * | Situación del caso seleccionado                                   | Resultado            |
 * | Cualquier test requerido confirma falla funcional                 | Failed (5)           |
 * | Sin falla confirmada y falta test/variante, bloqueo u omisión     | Blocked (2)          |
 * | Todos los requeridos pasaron, alguno tras retry                   | Passed (1) + comentario de inestabilidad |
 * | Todos pasaron al primer intento                                   | Passed (1)           |
 * | Cancelación/interrupción sin falla confirmada y cobertura incompleta | sin resultado externo (no_ejecutado) |
 *
 * Caso sin automatización → Blocked con causa `sin_automatizacion` (también en corridas canceladas, D-012).
 * Nunca se completa cobertura con corridas anteriores; la duración es la suma de intentos (tiempo de trabajo).
 * RF-TR-04, RF-TR-05, RF-RES-05.
 */
import {
  TESTRAIL_STATUS_IDS,
  type CaseResultStatus,
  type Coverage,
  type ResultReason,
  type RunResultStatus,
  type RunStatus,
} from '../enums.js';

export interface RequiredVariant {
  stableKey: string;
  parameterKey: string;
}

export interface ContributingResult extends RequiredVariant {
  runResultId?: string;
  status: RunResultStatus;
  reason?: ResultReason | null;
  /** Número de reintento en que pasó (inestable). */
  passedOnRetry?: number | null;
  /** Suma de duraciones de intentos del test (ms). */
  durationMs?: number | null;
  title?: string;
}

export interface CaseAggregateInput {
  /** Estado terminal de la corrida al agregar. */
  runStatus: Extract<RunStatus, 'terminada' | 'cancelada' | 'interrumpida' | 'omitida'>;
  /** Conjunto requerido congelado en el snapshot (todos los tests/variantes aprobados vinculados). */
  required: readonly RequiredVariant[];
  results: readonly ContributingResult[];
  /** Causa de bloqueo del caso en el plan (p. ej. `sin_automatizacion`, `caso_archivado`). */
  planBlockReason?: ResultReason | null;
}

export interface CaseAggregate {
  status: CaseResultStatus;
  coverage: Coverage;
  /** `null` = no se publica resultado externo. */
  testrailStatusId: 1 | 2 | 5 | null;
  publishable: boolean;
  durationMs: number | null;
  /** Variantes requeridas sin resultado ejecutado definitivo. */
  missing: RequiredVariant[];
  failed: RequiredVariant[];
  flakyRetries: { stableKey: string; parameterKey: string; retry: number }[];
  blockReasons: ResultReason[];
}

const keyOf = (v: RequiredVariant) => `${v.stableKey}#${v.parameterKey}`;
const EXECUTED_OK: readonly RunResultStatus[] = ['pasado', 'inestable'];
/** Incompletitud atribuible a cancelación/interrupción (no a política). */
const INTERRUPTION_STATUSES: readonly RunResultStatus[] = [
  'cancelado',
  'pendiente',
  'corriendo',
  'error_infraestructura',
];

export function aggregateCase(input: CaseAggregateInput): CaseAggregate {
  const byKey = new Map<string, ContributingResult>();
  for (const r of input.results) byKey.set(keyOf(r), r);
  const requiredResults = input.required.map((v) => ({ v, r: byKey.get(keyOf(v)) }));

  const failed = requiredResults.filter((x) => x.r?.status === 'fallido').map((x) => x.v);
  const okResults = requiredResults.filter((x) => x.r && EXECUTED_OK.includes(x.r.status));
  const executed = requiredResults.filter((x) => x.r && (EXECUTED_OK.includes(x.r.status) || x.r.status === 'fallido'));
  const missing = requiredResults
    .filter((x) => !x.r || !EXECUTED_OK.includes(x.r.status))
    .filter((x) => x.r?.status !== 'fallido')
    .map((x) => x.v);
  const coverage: Coverage =
    input.required.length === 0 || executed.length === 0
      ? 'ninguna'
      : executed.length === input.required.length
        ? 'completa'
        : 'parcial';
  const contributing = requiredResults.map((x) => x.r).filter((r): r is ContributingResult => !!r);
  const durations = contributing.map((r) => r.durationMs).filter((d): d is number => typeof d === 'number');
  const durationMs = durations.length ? durations.reduce((a, b) => a + b, 0) : null;
  const flakyRetries = okResults
    .filter((x) => x.r!.status === 'inestable')
    .map((x) => ({ stableKey: x.v.stableKey, parameterKey: x.v.parameterKey, retry: x.r!.passedOnRetry ?? 1 }));
  const blockReasons = new Set<ResultReason>();
  if (input.planBlockReason) blockReasons.add(input.planBlockReason);
  if (input.required.length === 0 && !input.planBlockReason) blockReasons.add('sin_automatizacion');
  for (const x of requiredResults) {
    if (!x.r) blockReasons.add('variante_faltante');
    else if (x.r.reason && !EXECUTED_OK.includes(x.r.status) && x.r.status !== 'fallido') blockReasons.add(x.r.reason);
  }

  const base = { coverage, durationMs, missing, failed, flakyRetries, blockReasons: [...blockReasons] };

  // Caso sin automatización o bloqueado en el plan: Blocked con causa explícita.
  if (input.required.length === 0 || input.planBlockReason) {
    return { ...base, status: 'bloqueado', testrailStatusId: TESTRAIL_STATUS_IDS.blocked, publishable: true };
  }
  // Omitida antes de iniciar: sin resultado externo.
  if (input.runStatus === 'omitida') {
    return { ...base, status: 'no_ejecutado', testrailStatusId: null, publishable: false };
  }
  // Falla funcional confirmada: Failed aunque el resto quede parcial (también en canceladas/interrumpidas).
  if (failed.length > 0) {
    return { ...base, status: 'fallido', testrailStatusId: TESTRAIL_STATUS_IDS.failed, publishable: true };
  }
  if (coverage === 'completa') {
    return {
      ...base,
      status: flakyRetries.length > 0 ? 'inestable' : 'pasado',
      testrailStatusId: TESTRAIL_STATUS_IDS.passed,
      publishable: true,
    };
  }
  // Incompleto sin falla.
  const interrupted = input.runStatus === 'cancelada' || input.runStatus === 'interrumpida';
  const incompletenessByInterruption = requiredResults.some((x) => !!x.r && INTERRUPTION_STATUSES.includes(x.r.status));
  if (interrupted && incompletenessByInterruption) {
    return { ...base, status: 'no_ejecutado', testrailStatusId: null, publishable: false };
  }
  return { ...base, status: 'bloqueado', testrailStatusId: TESTRAIL_STATUS_IDS.blocked, publishable: true };
}

/** Mapeo directo de estado agregado a `status_id` (ESP §8). */
export function testrailStatusIdFor(status: CaseResultStatus): 1 | 2 | 5 | null {
  switch (status) {
    case 'pasado':
    case 'inestable':
      return TESTRAIL_STATUS_IDS.passed;
    case 'fallido':
      return TESTRAIL_STATUS_IDS.failed;
    case 'bloqueado':
      return TESTRAIL_STATUS_IDS.blocked;
    case 'no_ejecutado':
    case 'pendiente':
      return null;
  }
}

/** Comentario de inestabilidad exacto de ESP §8. */
export function retryComment(n: number): string {
  return `pasó en el reintento ${n}`;
}

const REASON_TEXT: Partial<Record<ResultReason, string>> = {
  sin_automatizacion: 'caso sin automatización',
  caso_archivado: 'caso archivado',
  test_retirado: 'test retirado',
  test_no_aprobado: 'test no aprobado',
  clasificacion_ausente: 'clasificación ausente',
  clasificacion_contradictoria: 'clasificación contradictoria',
  escritura_en_produccion: 'test de escritura bloqueado en producción',
  revision_pendiente: 'vínculo con revisión pendiente',
  usuario_con_escritura: 'usuario de prueba con permisos de escritura en producción',
  ambiente_deshabilitado: 'ambiente deshabilitado',
  variante_faltante: 'falta test/variante requerida',
  excluido_inestable: 'test excluido por inestable',
  cancelado_por_usuario: 'cancelado por el usuario',
  worker_perdido: 'se perdió el worker',
  escritura_resultado_desconocido: 'escritura con resultado desconocido',
  login_fallido: 'falló el inicio de sesión',
  dependencia_fallida: 'falló una dependencia',
};

export function reasonText(reason: ResultReason): string {
  return REASON_TEXT[reason] ?? reason.replace(/_/g, ' ');
}

export interface CommentContext {
  runId: string;
  /** Enlace autenticado al detalle permanente de la ejecución (RF-TR-05). */
  runUrl: string;
  environmentName: string;
  /** Error sanitizado del primer test fallido, si existe (ya sanitizado por el llamador). */
  sanitizedError?: string | null;
  /** Nota de evidencia ausente/deshabilitada (RF-TR-05). */
  evidenceNote?: string | null;
  requiredCount: number;
}

/** Comentario para `add_results_for_cases`, con marcador del UUID local para reconciliación (ESP §13.4). */
export function buildTestRailComment(agg: CaseAggregate, ctx: CommentContext): string {
  const lines: string[] = [];
  const executed = ctx.requiredCount - agg.missing.length;
  lines.push(`Katalyst · ${ctx.environmentName}`);
  if (agg.status === 'inestable') {
    for (const f of agg.flakyRetries) lines.push(`Inestable: ${retryComment(f.retry)}.`);
  }
  if (agg.status === 'fallido') lines.push(`Falla funcional confirmada en ${agg.failed.length} test(s).`);
  if (agg.status === 'bloqueado') {
    const causes = agg.blockReasons.length ? agg.blockReasons.map(reasonText).join('; ') : 'cobertura incompleta';
    lines.push(`Bloqueado: ${causes}.`);
  }
  lines.push(`Cobertura: ${agg.coverage} (${Math.max(executed, 0)}/${ctx.requiredCount} tests requeridos).`);
  if (ctx.sanitizedError) lines.push(`Error: ${ctx.sanitizedError}`);
  if (ctx.evidenceNote) lines.push(`Evidencia: ${ctx.evidenceNote}`);
  lines.push(`Detalle: ${ctx.runUrl}`);
  lines.push(`[katalyst-run:${ctx.runId}]`);
  return lines.join('\n');
}

/** Marcador para reconciliar tras timeout ambiguo (ESP §13.4). */
export function runMarker(runId: string): string {
  return `[katalyst-run:${runId}]`;
}

/** Nombre de corrida TestRail: `QA Runner · <suite> · <ambiente> · <fecha hora>` (ESP §8) + marcador. */
export function testrailRunName(
  suiteName: string,
  environmentName: string,
  localDateTime: string,
  runId: string,
): string {
  return `QA Runner · ${suiteName} · ${environmentName} · ${localDateTime} ${runMarker(runId)}`;
}

/** Formato `elapsed` de TestRail (`1h 2m 3s`; mínimo `1s`). */
export function toTestRailElapsed(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  let s = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].filter(Boolean).join(' ');
}

/** Lotes de hasta 100 resultados por llamada (ESP §8). */
export function chunk<T>(items: readonly T[], size = 100): T[][] {
  if (size < 1) throw new RangeError('size debe ser >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
