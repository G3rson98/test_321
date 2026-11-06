/**
 * Integración con PostgreSQL real (TEST_DATABASE_URL): la migración aplica, existen tablas, restricciones únicas de
 * ESP §7, índices de §17.4, índices parciales escritos a mano, y los enums coinciden con @katalyst/shared.
 * RF-EJE-08, RF-PRG-04, RF-CAT-05, RNF-CON-01, RNF-OPT-05.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import * as shared from '@katalyst/shared';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
afterAll(async () => prisma.$disconnect());

const EXPECTED_TABLES = [
  'panel_user',
  'panel_session',
  'password_reset_token',
  'api_credential',
  'audit_log',
  'testrail_connection',
  'testrail_project',
  'testrail_suite',
  'testrail_section',
  'testrail_case',
  'case_revision',
  'testrail_sync_run',
  'testrail_case_staging',
  'catalog_revision',
  'automated_test',
  'test_case_link',
  'suite',
  'environment',
  'test_user',
  'runtime_setting',
  'schedule',
  'schedule_revision',
  'schedule_occurrence',
  'reconciliation_cursor',
  'exclusion_window',
  'run',
  'run_testrail_target',
  'run_shard',
  'worker_lease',
  'run_result',
  'test_attempt',
  'case_result',
  'capacity_reservation',
  'idempotency_key',
  'outbox_delivery',
  'event_log',
  'artifact',
  'recording_session',
  'device',
  'device_authorization',
  'perf_sample',
  'perf_hourly_aggregate',
  'perf_threshold',
  'event_mark',
  'alert',
  'notification_channel',
  'notification_preference',
  'notification_schedule_subscription',
  'notification_threshold_subscription',
  'export_job',
  'generation_request',
];

/** Índices únicos de ESP §7 "Restricciones mínimas" + extensiones (nombre → tabla). */
const EXPECTED_UNIQUE: Record<string, string> = {
  ux_testrail_project_connection_external: 'testrail_project',
  ux_testrail_suite_connection_external: 'testrail_suite',
  ux_testrail_section_connection_external: 'testrail_section',
  ux_testrail_case_connection_external: 'testrail_case',
  ux_automated_test_stable_key: 'automated_test',
  ux_test_case_link_test_case: 'test_case_link',
  ux_schedule_occurrence_schedule_instant: 'schedule_occurrence',
  ux_run_result_run_test_param: 'run_result',
  ux_test_attempt_result_attempt: 'test_attempt',
  ux_case_result_run_case: 'case_result',
  ux_run_testrail_target_run_suite: 'run_testrail_target',
  ux_run_shard_run_key: 'run_shard',
  ux_outbox_delivery_dedup_key: 'outbox_delivery',
  ux_perf_sample_run_sample_key: 'perf_sample',
  panel_user_email_key: 'panel_user',
  ux_idempotency_key_actor_key: 'idempotency_key',
  ux_worker_lease_shard_generation: 'worker_lease',
  ux_alert_fingerprint: 'alert',
  // Parciales (escritos a mano)
  ux_worker_lease_active_per_shard: 'worker_lease',
  ux_test_attempt_running_per_result: 'test_attempt',
  ux_run_active_per_schedule: 'run',
  ux_capacity_reservation_slot_active: 'capacity_reservation',
  ux_capacity_reservation_shard_scope: 'capacity_reservation',
  ux_panel_user_auth_subject: 'panel_user',
  ux_environment_name_active: 'environment',
};

/** Índices compuestos de ESP §17.4 / §7 (nombre → columnas en orden). */
const EXPECTED_INDEXES: Record<string, string[]> = {
  ix_run_environment_created_id: ['environment_id', 'created_at', 'id'],
  ux_run_result_run_test_param: ['run_id', 'automated_test_id', 'parameter_key'],
  ix_testrail_case_section_title_id: ['section_id', 'title', 'id'],
  ix_outbox_delivery_status_next_attempt: ['status', 'next_attempt_at'],
  ix_audit_log_created_at_id: ['created_at', 'id'],
  ix_perf_sample_env_endpoint_source_ts: ['environment_id', 'endpoint_key', 'source', 'ts'],
};

const ENUMS: Record<string, readonly string[]> = {
  run_status: shared.RUN_STATUSES,
  run_outcome: shared.RUN_OUTCOMES,
  sync_status: shared.SYNC_STATUSES,
  run_trigger: shared.RUN_TRIGGERS,
  run_result_status: shared.RUN_RESULT_STATUSES,
  attempt_kind: shared.ATTEMPT_KINDS,
  attempt_status: shared.ATTEMPT_STATUSES,
  error_category: shared.ERROR_CATEGORIES,
  shard_status: shared.SHARD_STATUSES,
  coverage: shared.COVERAGES,
  case_result_status: shared.CASE_RESULT_STATUSES,
  result_reason: shared.RESULT_REASONS,
  occurrence_status: shared.OCCURRENCE_STATUSES,
  occurrence_skip_reason: shared.OCCURRENCE_SKIP_REASONS,
  classification: shared.CLASSIFICATIONS,
  test_status: shared.TEST_STATUSES,
  link_review_status: shared.LINK_REVIEW_STATUSES,
  sync_run_status: shared.SYNC_RUN_STATUSES,
  catalog_revision_status: shared.CATALOG_REVISION_STATUSES,
  outbox_status: shared.OUTBOX_STATUSES,
  notification_channel_kind: shared.NOTIFICATION_CHANNEL_KINDS,
  notification_event: shared.NOTIFICATION_EVENTS,
  alert_kind: shared.ALERT_KINDS,
  alert_status: shared.ALERT_STATUSES,
  artifact_kind: shared.ARTIFACT_KINDS,
  sanitization_status: shared.SANITIZATION_STATUSES,
  perf_source: shared.PERF_SOURCES,
  perf_metric: shared.PERF_METRICS,
  perf_metric_kind: shared.PERF_METRIC_KINDS,
  perf_provenance: shared.PERF_PROVENANCES,
  perf_error_kind: shared.PERF_ERROR_KINDS,
  cache_mode: shared.CACHE_MODES,
  recording_status: shared.RECORDING_STATUSES,
  device_authorization_status: shared.DEVICE_AUTHORIZATION_STATUSES,
  panel_role: shared.PANEL_ROLES,
  api_credential_kind: shared.API_CREDENTIAL_KINDS,
  actor_kind: shared.ACTOR_KINDS,
  export_format: shared.EXPORT_FORMATS,
  job_status: shared.JOB_STATUSES,
  generation_status: shared.GENERATION_STATUSES,
  generation_kind: shared.GENERATION_KINDS,
};

describe('migración inicial', () => {
  it('RNF-MAN-02 la migración está aplicada (_prisma_migrations)', async () => {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at FROM _prisma_migrations`;
    expect(rows.some((r) => r.migration_name.endsWith('_init') && r.finished_at !== null)).toBe(true);
  });

  it('ESP §7 existen todas las tablas', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) expect(names.has(t), t).toBe(true);
  });

  it('ESP §7 restricciones únicas clave y parciales existen', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; tablename: string; indexdef: string }[]>`
      SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`;
    const byName = new Map(rows.map((r) => [r.indexname, r]));
    for (const [name, table] of Object.entries(EXPECTED_UNIQUE)) {
      const idx = byName.get(name);
      expect(idx, name).toBeDefined();
      expect(idx!.tablename).toBe(table);
      expect(idx!.indexdef, name).toMatch(/CREATE UNIQUE INDEX/);
    }
    expect(byName.get('ux_worker_lease_active_per_shard')!.indexdef).toMatch(/WHERE .*revoked_at IS NULL/);
    expect(byName.get('ux_run_active_per_schedule')!.indexdef).toMatch(/en_cola/);
  });

  it('ESP §17.4 índices compuestos con columnas en orden', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; cols: string[] }[]>`
      SELECT i.relname AS indexname,
             array_agg(a.attname ORDER BY k.ord)::text[] AS cols
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
      WHERE i.relname = ANY(${Object.keys(EXPECTED_INDEXES)})
      GROUP BY i.relname`;
    const byName = new Map(rows.map((r) => [r.indexname, r.cols]));
    for (const [name, cols] of Object.entries(EXPECTED_INDEXES)) expect(byName.get(name), name).toEqual(cols);
  });

  it('ESP §7 FK compuesta de sección padre en la misma suite y CHECKs escritos a mano', async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`;
    const names = new Set(rows.map((r) => r.conname));
    for (const c of [
      'testrail_section_parent_id_suite_id_fkey',
      'ck_panel_user_email_lower',
      'ck_run_retries',
      'ck_schedule_retries',
      'ck_exclusion_window_range',
      'ck_perf_threshold_min_samples',
      'ck_perf_sample_nonneg',
      'ck_perf_sample_timeout_censored',
      'ck_perf_sample_censored_timeout',
      'ck_perf_sample_over_29s',
      'ck_api_credential_principal',
      'ck_testrail_section_parent',
    ]) {
      expect(names.has(c), c).toBe(true);
    }
  });

  it('enums de PostgreSQL = enums de @katalyst/shared (mismos valores y orden)', async () => {
    const rows = await prisma.$queryRaw<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      GROUP BY t.typname`;
    const byName = new Map(rows.map((r) => [r.typname, r.labels]));
    for (const [typ, values] of Object.entries(ENUMS)) expect(byName.get(typ), typ).toEqual([...values]);
    // Ningún enum de BD sin contraparte en shared.
    for (const typ of byName.keys()) expect(Object.keys(ENUMS), typ).toContain(typ);
  });
});

class Rollback extends Error {}

/** Ejecuta `fn` en una transacción que siempre se revierte; devuelve el error de unicidad esperado. */
async function expectUniqueViolation(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<string> {
  let code = '';
  try {
    await prisma.$transaction(async (tx) => {
      try {
        await fn(tx);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError) code = e.code;
        else if (e instanceof Error && /23505|unique/i.test(e.message)) code = 'P2002';
        else throw e;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return code;
}

async function seedRun(tx: Prisma.TransactionClient, scheduleId?: string) {
  const env = await tx.environment.create({
    data: {
      name: `env-${randomUUID()}`,
      appUrl: 'https://app.test',
      apiUrl: 'https://api.test',
      isProduction: false,
      allowedHosts: [],
    },
  });
  const test = await tx.automatedTest.create({
    data: {
      stableKey: randomUUID(),
      filePath: 'tests/oc/a.spec.ts',
      title: 'C1 Test @oc',
      tags: ['@oc'],
      classification: 'lectura',
      status: 'aprobado',
    },
  });
  const run = await tx.run.create({
    data: {
      trigger: 'manual',
      environmentId: env.id,
      selectionSnapshot: {},
      manifestHash: 'a'.repeat(64),
      gitCommit: 'b'.repeat(40),
      ...(scheduleId ? { scheduleId } : {}),
    },
  });
  return { env, test, run };
}

describe('unicidad e idempotencia (RF-EJE-08, RF-PRG-04)', () => {
  it('RF-EJE-08 (run_id, automated_test_id, parameter_key) duplicado falla y parameter_key default = "default"', async () => {
    const code = await expectUniqueViolation(async (tx) => {
      const { test, run } = await seedRun(tx);
      const r = await tx.runResult.create({ data: { runId: run.id, automatedTestId: test.id } });
      expect(r.parameterKey).toBe('default');
      await tx.runResult.create({ data: { runId: run.id, automatedTestId: test.id, parameterKey: 'default' } });
    });
    expect(code).toBe('P2002');
  });

  it('RF-EJE-08 (run_result_id, attempt_no) duplicado falla', async () => {
    const code = await expectUniqueViolation(async (tx) => {
      const { test, run } = await seedRun(tx);
      const r = await tx.runResult.create({ data: { runId: run.id, automatedTestId: test.id } });
      await tx.testAttempt.create({
        data: { runResultId: r.id, attemptNo: 1, kind: 'inicial', status: 'pasado', startedAt: new Date() },
      });
      await tx.testAttempt.create({
        data: { runResultId: r.id, attemptNo: 1, kind: 'inicial', status: 'pasado', startedAt: new Date() },
      });
    });
    expect(code).toBe('P2002');
  });

  it('RF-PRG-04 (schedule_id, scheduled_for) duplicado falla', async () => {
    const code = await expectUniqueViolation(async (tx) => {
      const { env } = await seedRun(tx);
      const s = await tx.schedule.create({
        data: {
          name: 's',
          selector: { kind: 'tags', tags: ['@humo'] },
          environmentId: env.id,
          cronExpressions: ['0 8 * * 1-5'],
        },
      });
      const at = new Date('2026-11-09T12:00:00Z');
      await tx.scheduleOccurrence.create({
        data: {
          scheduleId: s.id,
          scheduleRevision: 1,
          scheduledFor: at,
          timezone: 'America/La_Paz',
          status: 'admitida',
        },
      });
      await tx.scheduleOccurrence.create({
        data: {
          scheduleId: s.id,
          scheduleRevision: 1,
          scheduledFor: at,
          timezone: 'America/La_Paz',
          status: 'omitida',
          reason: 'solapamiento',
        },
      });
    });
    expect(code).toBe('P2002');
  });

  it('RF-PRG-04 máximo una corrida activa o en cola por programación (índice parcial)', async () => {
    const code = await expectUniqueViolation(async (tx) => {
      const { env } = await seedRun(tx);
      const s = await tx.schedule.create({
        data: {
          name: 's',
          selector: { kind: 'tags', tags: ['@humo'] },
          environmentId: env.id,
          cronExpressions: ['0 8 * * 1-5'],
        },
      });
      const base = {
        trigger: 'programada' as const,
        environmentId: env.id,
        selectionSnapshot: {},
        manifestHash: 'a'.repeat(64),
        gitCommit: 'b'.repeat(40),
        scheduleId: s.id,
      };
      await tx.run.create({ data: { ...base, status: 'terminada' } });
      await tx.run.create({ data: { ...base, status: 'corriendo' } });
      await tx.run.create({ data: { ...base, status: 'en_cola' } });
    });
    expect(code).toBe('P2002');
  });

  it('RNF-CON-01 como máximo un lease vigente por shard (índice parcial)', async () => {
    const code = await expectUniqueViolation(async (tx) => {
      const { run } = await seedRun(tx);
      const shard = await tx.runShard.create({ data: { runId: run.id, shardKey: 's0', assignedTestKeys: [] } });
      const now = new Date();
      const lease = {
        runShardId: shard.id,
        workerId: 'w',
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + 75_000),
      };
      await tx.workerLease.create({ data: { ...lease, generation: 1, tokenHash: randomUUID(), revokedAt: now } });
      await tx.workerLease.create({ data: { ...lease, generation: 2, tokenHash: randomUUID() } });
      await tx.workerLease.create({ data: { ...lease, generation: 3, tokenHash: randomUUID() } });
    });
    expect(code).toBe('P2002');
  });

  it('RF-CAT-05 stable_key único', async () => {
    const code = await expectUniqueViolation(async (tx) => {
      const key = randomUUID();
      const data = {
        stableKey: key,
        filePath: 'tests/a.spec.ts',
        title: 'C1 t',
        tags: [],
        classification: 'lectura' as const,
        status: 'aprobado' as const,
      };
      await tx.automatedTest.create({ data });
      await tx.automatedTest.create({ data: { ...data, title: 'C1 renombrado' } });
    });
    expect(code).toBe('P2002');
  });

  it('RF-USR-01 correo debe estar normalizado en minúsculas (CHECK)', async () => {
    let failed = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.panelUser.create({ data: { email: 'QA@Example.com', name: 'x', role: 'qa' } });
        throw new Rollback();
      });
    } catch (e) {
      failed = !(e instanceof Rollback);
    }
    expect(failed).toBe(true);
  });
});
