-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('en_cola', 'preparando', 'corriendo', 'finalizando', 'terminada', 'cancelando', 'cancelada', 'interrumpida', 'omitida');

-- CreateEnum
CREATE TYPE "run_outcome" AS ENUM ('pasado', 'inestable', 'fallido', 'bloqueado', 'incompleto');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('no_aplica', 'pendiente', 'enviando', 'sincronizada', 'requiere_intervencion');

-- CreateEnum
CREATE TYPE "run_trigger" AS ENUM ('manual', 'programada', 'api');

-- CreateEnum
CREATE TYPE "run_result_status" AS ENUM ('pendiente', 'corriendo', 'pasado', 'inestable', 'fallido', 'bloqueado', 'omitido', 'cancelado', 'error_infraestructura');

-- CreateEnum
CREATE TYPE "attempt_kind" AS ENUM ('inicial', 'retry', 'recuperacion');

-- CreateEnum
CREATE TYPE "attempt_status" AS ENUM ('corriendo', 'pasado', 'fallido', 'omitido', 'cancelado', 'error_infraestructura');

-- CreateEnum
CREATE TYPE "error_category" AS ENUM ('asercion', 'timeout_aplicacion', 'error_aplicacion', 'login', 'navegador_no_disponible', 'worker_perdido', 'resultado_desconocido', 'timeout_corrida', 'infraestructura', 'politica', 'configuracion', 'cancelacion', 'desconocido');

-- CreateEnum
CREATE TYPE "shard_status" AS ENUM ('pendiente', 'asignado', 'corriendo', 'completado', 'cancelado', 'interrumpido');

-- CreateEnum
CREATE TYPE "coverage" AS ENUM ('completa', 'parcial', 'ninguna');

-- CreateEnum
CREATE TYPE "case_result_status" AS ENUM ('pendiente', 'pasado', 'inestable', 'fallido', 'bloqueado', 'no_ejecutado');

-- CreateEnum
CREATE TYPE "result_reason" AS ENUM ('sin_automatizacion', 'caso_archivado', 'test_retirado', 'test_no_aprobado', 'clasificacion_ausente', 'clasificacion_contradictoria', 'escritura_en_produccion', 'revision_pendiente', 'usuario_con_escritura', 'ambiente_deshabilitado', 'manifiesto_invalido', 'commit_no_disponible', 'variante_faltante', 'excluido_inestable', 'cancelado_por_usuario', 'cancelado_por_programacion', 'worker_perdido', 'recuperacion_agotada', 'escritura_resultado_desconocido', 'timeout_test', 'timeout_preparacion', 'timeout_corrida', 'login_fallido', 'dependencia_fallida', 'sin_capacidad', 'error_interno');

-- CreateEnum
CREATE TYPE "occurrence_status" AS ENUM ('admitida', 'omitida');

-- CreateEnum
CREATE TYPE "occurrence_skip_reason" AS ENUM ('solapamiento', 'sin_capacidad', 'caida_servicio', 'ventana_exclusion', 'programacion_pausada', 'configuracion_invalida', 'seleccion_vacia', 'ambiente_deshabilitado');

-- CreateEnum
CREATE TYPE "classification" AS ENUM ('lectura', 'escritura', 'sin_clasificar');

-- CreateEnum
CREATE TYPE "test_status" AS ENUM ('borrador', 'aprobado', 'retirado');

-- CreateEnum
CREATE TYPE "link_review_status" AS ENUM ('vigente', 'requiere_revision');

-- CreateEnum
CREATE TYPE "sync_run_status" AS ENUM ('nunca', 'en_curso', 'exitosa', 'fallida');

-- CreateEnum
CREATE TYPE "catalog_revision_status" AS ENUM ('en_curso', 'completa', 'fallida');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pendiente', 'en_proceso', 'entregada', 'requiere_intervencion', 'vencida', 'cancelada');

-- CreateEnum
CREATE TYPE "notification_channel_kind" AS ENUM ('correo', 'slack', 'teams');

-- CreateEnum
CREATE TYPE "notification_event" AS ENUM ('corrida_con_fallas', 'corrida_interrumpida', 'umbral_superado', 'sync_requiere_intervencion');

-- CreateEnum
CREATE TYPE "alert_kind" AS ENUM ('umbral_rendimiento', 'corrida_fallida', 'corrida_interrumpida', 'disponibilidad');

-- CreateEnum
CREATE TYPE "alert_status" AS ENUM ('activa', 'recuperada');

-- CreateEnum
CREATE TYPE "artifact_kind" AS ENUM ('reporte', 'traza', 'video', 'captura', 'log', 'dxmon_samples', 'dxmon_summary');

-- CreateEnum
CREATE TYPE "sanitization_status" AS ENUM ('pendiente', 'sanitizado', 'deshabilitado', 'fallido', 'retenido');

-- CreateEnum
CREATE TYPE "perf_source" AS ENUM ('ui', 'raiz', 'probe', 'app');

-- CreateEnum
CREATE TYPE "perf_metric" AS ENUM ('p95', 'max', 'error_rate', 'timeout_rate');

-- CreateEnum
CREATE TYPE "perf_metric_kind" AS ENUM ('network_request', 'screen_ready', 'root_ready', 'root_current_wait');

-- CreateEnum
CREATE TYPE "perf_provenance" AS ENUM ('dxmon', 'playwright');

-- CreateEnum
CREATE TYPE "perf_error_kind" AS ENUM ('http', 'red', 'timeout', 'condicion');

-- CreateEnum
CREATE TYPE "cache_mode" AS ENUM ('fria', 'caliente', 'desconocida');

-- CreateEnum
CREATE TYPE "recording_status" AS ENUM ('creada', 'vinculada', 'grabando', 'validando', 'pr_abierto', 'rechazada', 'cancelada', 'vencida');

-- CreateEnum
CREATE TYPE "device_authorization_status" AS ENUM ('pendiente', 'aprobada', 'denegada', 'vencida', 'consumida');

-- CreateEnum
CREATE TYPE "panel_role" AS ENUM ('qa', 'dev', 'admin');

-- CreateEnum
CREATE TYPE "api_credential_kind" AS ENUM ('token_api', 'servicio_supervisor', 'dispositivo');

-- CreateEnum
CREATE TYPE "actor_kind" AS ENUM ('panel_user', 'api_credential', 'servicio', 'sistema');

-- CreateEnum
CREATE TYPE "export_format" AS ENUM ('csv', 'pdf');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('pendiente', 'en_proceso', 'listo', 'fallido', 'vencido');

-- CreateEnum
CREATE TYPE "generation_status" AS ENUM ('pendiente', 'en_proceso', 'listo', 'fallido', 'rechazado_presupuesto');

-- CreateEnum
CREATE TYPE "generation_kind" AS ENUM ('borrador_desde_caso', 'revision_grabacion');

-- CreateTable
CREATE TABLE "panel_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "panel_role" NOT NULL,
    "auth_subject" TEXT,
    "password_hash" TEXT,
    "disabled_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "panel_session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "ip_hash" TEXT,
    "user_agent_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credential" (
    "id" UUID NOT NULL,
    "principal_id" UUID,
    "service_name" TEXT,
    "kind" "api_credential_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "hint" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_kind" "actor_kind" NOT NULL,
    "actor_id" UUID,
    "actor_display" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "diff" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_connection" (
    "id" UUID NOT NULL,
    "base_url" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "project_external_id" INTEGER,
    "suite_external_ids" INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMPTZ(6),
    "last_sync_status" "sync_run_status" NOT NULL DEFAULT 'nunca',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testrail_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_project" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testrail_project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_suite" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "external_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testrail_suite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_section" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "tr_section_id" INTEGER NOT NULL,
    "suite_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testrail_section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_case" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "tr_case_id" INTEGER NOT NULL,
    "section_id" UUID NOT NULL,
    "suite_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "expected" TEXT,
    "priority" TEXT,
    "type" TEXT,
    "refs" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "content_hash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testrail_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_revision" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_sync_run" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "status" "sync_run_status" NOT NULL,
    "trigger" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testrail_sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_case_staging" (
    "id" UUID NOT NULL,
    "sync_run_id" UUID NOT NULL,
    "tr_case_id" INTEGER NOT NULL,
    "tr_section_id" INTEGER NOT NULL,
    "tr_suite_id" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testrail_case_staging_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_revision" (
    "id" UUID NOT NULL,
    "status" "catalog_revision_status" NOT NULL,
    "git_commit" TEXT,
    "manifest_hash" TEXT,
    "manifest" JSONB,
    "playwright_list" JSONB,
    "test_count" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automated_test" (
    "id" UUID NOT NULL,
    "stable_key" UUID NOT NULL,
    "file_path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tags" TEXT[],
    "classification" "classification" NOT NULL,
    "status" "test_status" NOT NULL,
    "parameter_keys" TEXT[] DEFAULT ARRAY['default']::TEXT[],
    "write_idempotency_approved" BOOLEAN NOT NULL DEFAULT false,
    "owner" TEXT,
    "flaky_score" DOUBLE PRECISION,
    "flaky_numerator" INTEGER NOT NULL DEFAULT 0,
    "flaky_denominator" INTEGER NOT NULL DEFAULT 0,
    "manifest_commit" TEXT,
    "catalog_revision_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automated_test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_case_link" (
    "id" UUID NOT NULL,
    "automated_test_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "reviewed_case_revision" INTEGER,
    "review_status" "link_review_status" NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_case_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suite" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "selector" JSONB NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "app_url" TEXT NOT NULL,
    "api_url" TEXT NOT NULL,
    "is_production" BOOLEAN NOT NULL,
    "max_concurrency" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_at" TIMESTAMPTZ(6),
    "recording_allowed" BOOLEAN NOT NULL DEFAULT false,
    "artifact_policy" JSONB NOT NULL DEFAULT '{}',
    "allowed_hosts" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_user" (
    "id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "read_only" BOOLEAN NOT NULL DEFAULT true,
    "allows_concurrency" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_setting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "suite_id" UUID,
    "selector" JSONB NOT NULL,
    "environment_id" UUID NOT NULL,
    "cron_expressions" TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'America/La_Paz',
    "window_start" TEXT,
    "window_end" TEXT,
    "editor" JSONB,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "paused_at" TIMESTAMPTZ(6),
    "retries" INTEGER NOT NULL DEFAULT 0,
    "notify" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_revision" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "changed_by" UUID,
    "diff" JSONB NOT NULL DEFAULT '{}',
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_occurrence" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "schedule_revision" INTEGER NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "occurrence_status" NOT NULL,
    "reason" "occurrence_skip_reason",
    "run_id" UUID,
    "admitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_cursor" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "reconciled_until" TIMESTAMPTZ(6) NOT NULL,
    "schedule_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exclusion_window" (
    "id" UUID NOT NULL,
    "environment_id" UUID,
    "schedule_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exclusion_window_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run" (
    "id" UUID NOT NULL,
    "trigger" "run_trigger" NOT NULL,
    "suite_id" UUID,
    "schedule_id" UUID,
    "environment_id" UUID NOT NULL,
    "status" "run_status" NOT NULL DEFAULT 'en_cola',
    "outcome" "run_outcome",
    "sync_status" "sync_status" NOT NULL DEFAULT 'no_aplica',
    "reason" "result_reason",
    "selection_snapshot" JSONB NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "catalog_revision_id" UUID,
    "manifest_hash" TEXT NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6),
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "cancel_requested_at" TIMESTAMPTZ(6),
    "git_commit" TEXT NOT NULL,
    "runtime_versions" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_by_credential_id" UUID,
    "idempotency_key" TEXT,
    "evidence_incomplete" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_testrail_target" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "testrail_suite_id" UUID NOT NULL,
    "tr_run_id" INTEGER,
    "existing_run" BOOLEAN NOT NULL DEFAULT false,
    "close_existing_run" BOOLEAN NOT NULL DEFAULT false,
    "sync_status" "sync_status" NOT NULL DEFAULT 'pendiente',
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_testrail_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_shard" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "shard_key" TEXT NOT NULL,
    "status" "shard_status" NOT NULL DEFAULT 'pendiente',
    "assigned_test_keys" JSONB NOT NULL,
    "recovery_count" INTEGER NOT NULL DEFAULT 0,
    "current_generation" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_shard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_lease" (
    "id" UUID NOT NULL,
    "run_shard_id" UUID NOT NULL,
    "worker_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_result" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "automated_test_id" UUID NOT NULL,
    "parameter_key" TEXT NOT NULL DEFAULT 'default',
    "run_shard_id" UUID,
    "owner_lease_id" UUID,
    "status" "run_result_status" NOT NULL DEFAULT 'pendiente',
    "reason" "result_reason",
    "reason_text" TEXT,
    "duration_ms" INTEGER,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "infra_recovery_count" INTEGER NOT NULL DEFAULT 0,
    "evidence_incomplete" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_attempt" (
    "id" UUID NOT NULL,
    "run_result_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "kind" "attempt_kind" NOT NULL,
    "status" "attempt_status" NOT NULL DEFAULT 'corriendo',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,
    "error_category" "error_category",
    "error" TEXT,
    "worker_lease_id" UUID,
    "start_request_hash" TEXT,
    "result_request_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_result" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "case_revision" INTEGER NOT NULL,
    "run_testrail_target_id" UUID,
    "status" "case_result_status" NOT NULL DEFAULT 'pendiente',
    "coverage" "coverage" NOT NULL DEFAULT 'ninguna',
    "contributing_results" JSONB NOT NULL DEFAULT '[]',
    "duration_ms" INTEGER,
    "comment" TEXT,
    "publishable" BOOLEAN NOT NULL DEFAULT false,
    "sync_status" "sync_status" NOT NULL DEFAULT 'no_aplica',
    "tr_result_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_reservation" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "run_id" UUID NOT NULL,
    "run_shard_id" UUID,
    "environment_id" UUID,
    "test_user_id" UUID,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capacity_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "actor_key" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'en_proceso',
    "response_status" INTEGER,
    "response_body" JSONB,
    "run_id" UUID,
    "user_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_delivery" (
    "id" UUID NOT NULL,
    "run_id" UUID,
    "target_id" UUID,
    "alert_id" UUID,
    "operation" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'pendiente',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "external_id" TEXT,
    "last_error" TEXT,
    "last_http_status" INTEGER,
    "locked_until" TIMESTAMPTZ(6),
    "locked_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_log" (
    "seq" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "run_id" UUID,
    "environment_id" UUID,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "artifact" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "run_result_id" UUID,
    "test_attempt_id" UUID,
    "kind" "artifact_kind" NOT NULL,
    "content_type" TEXT NOT NULL,
    "storage_key" TEXT,
    "size_bytes" BIGINT,
    "checksum" TEXT,
    "sanitization_status" "sanitization_status" NOT NULL DEFAULT 'pendiente',
    "sanitization_reason" TEXT,
    "uploaded_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_session" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "device_id" UUID,
    "status" "recording_status" NOT NULL DEFAULT 'creada',
    "tags" TEXT[],
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "branch" TEXT,
    "pr_url" TEXT,
    "commit" TEXT,
    "rejection_reasons" JSONB NOT NULL DEFAULT '[]',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "code_storage_key" TEXT,
    "code_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recording_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "client_version" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_authorization" (
    "id" UUID NOT NULL,
    "device_code_hash" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "client_version" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" "device_authorization_status" NOT NULL DEFAULT 'pendiente',
    "user_id" UUID,
    "device_id" UUID,
    "interval_seconds" INTEGER NOT NULL DEFAULT 5,
    "last_polled_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perf_sample" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "sample_key" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "provenance" "perf_provenance" NOT NULL,
    "source" "perf_source" NOT NULL,
    "metric_kind" "perf_metric_kind" NOT NULL,
    "endpoint" TEXT,
    "endpoint_key" TEXT NOT NULL,
    "method" TEXT,
    "screen_key" TEXT,
    "status_code" INTEGER,
    "ok" BOOLEAN,
    "total_ms" DOUBLE PRECISION,
    "ttfb_ms" DOUBLE PRECISION,
    "download_ms" DOUBLE PRECISION,
    "bytes_wire" BIGINT,
    "bytes_body" BIGINT,
    "timeout" BOOLEAN NOT NULL DEFAULT false,
    "timeout_limit_ms" DOUBLE PRECISION,
    "censored_at_ms" DOUBLE PRECISION,
    "censored" BOOLEAN NOT NULL DEFAULT false,
    "network_error" BOOLEAN NOT NULL DEFAULT false,
    "error_kind" "perf_error_kind",
    "over_29s" BOOLEAN NOT NULL DEFAULT false,
    "visible" BOOLEAN,
    "cache_mode" "cache_mode" NOT NULL DEFAULT 'desconocida',
    "worker_profile" TEXT,
    "invalid_reason" TEXT,
    "content_encoding" TEXT,
    "null_reasons" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "perf_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perf_hourly_aggregate" (
    "id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "endpoint_key" TEXT NOT NULL,
    "provenance" "perf_provenance" NOT NULL,
    "source" "perf_source" NOT NULL,
    "metric_kind" "perf_metric_kind" NOT NULL,
    "cache_mode" "cache_mode" NOT NULL,
    "worker_profile" TEXT NOT NULL DEFAULT '',
    "bucket_start" TIMESTAMPTZ(6) NOT NULL,
    "started" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "discarded" INTEGER NOT NULL DEFAULT 0,
    "sum_ms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sum_sq_ms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "min_ms" DOUBLE PRECISION,
    "max_ms" DOUBLE PRECISION,
    "http_errors" INTEGER NOT NULL DEFAULT 0,
    "network_errors" INTEGER NOT NULL DEFAULT 0,
    "timeouts" INTEGER NOT NULL DEFAULT 0,
    "over_29s" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "perf_hourly_aggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perf_threshold" (
    "id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "series_selector" JSONB NOT NULL,
    "endpoint_key" TEXT NOT NULL,
    "source" "perf_source" NOT NULL,
    "metric_kind" "perf_metric_kind" NOT NULL,
    "cache_mode" "cache_mode" NOT NULL,
    "worker_profile" TEXT,
    "metric" "perf_metric" NOT NULL,
    "limit" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "window_min" INTEGER NOT NULL,
    "min_samples" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "last_evaluated_at" TIMESTAMPTZ(6),
    "last_state" TEXT,
    "last_value" DOUBLE PRECISION,
    "last_n" INTEGER,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "perf_threshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_mark" (
    "id" UUID NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "label" TEXT NOT NULL,
    "environment_id" UUID NOT NULL,
    "frontend_version" TEXT,
    "backend_version" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_mark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert" (
    "id" UUID NOT NULL,
    "kind" "alert_kind" NOT NULL,
    "environment_id" UUID,
    "threshold_id" UUID,
    "run_id" UUID,
    "fingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "alert_status" NOT NULL DEFAULT 'activa',
    "channel" "notification_channel_kind",
    "last_sent_at" TIMESTAMPTZ(6),
    "send_count" INTEGER NOT NULL DEFAULT 0,
    "recovered_at" TIMESTAMPTZ(6),
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channel" (
    "id" UUID NOT NULL,
    "kind" "notification_channel_kind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "secret_ref" TEXT,
    "recipients" TEXT[],
    "smtp" JSONB,
    "last_test_at" TIMESTAMPTZ(6),
    "last_test_ok" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channels" "notification_channel_kind"[],
    "events" "notification_event"[],
    "all_schedules" BOOLEAN NOT NULL DEFAULT false,
    "all_thresholds" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_schedule_subscription" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_schedule_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_threshold_subscription" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "threshold_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_threshold_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_job" (
    "id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "format" "export_format" NOT NULL,
    "scope" TEXT NOT NULL,
    "extent" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "status" "job_status" NOT NULL DEFAULT 'pendiente',
    "row_count" INTEGER,
    "size_bytes" BIGINT,
    "storage_key" TEXT,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_request" (
    "id" UUID NOT NULL,
    "kind" "generation_kind" NOT NULL,
    "status" "generation_status" NOT NULL DEFAULT 'pendiente',
    "case_id" UUID,
    "recording_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "result" JSONB,
    "error" TEXT,
    "created_by" UUID NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "panel_user_email_key" ON "panel_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "panel_session_token_hash_key" ON "panel_session"("token_hash");

-- CreateIndex
CREATE INDEX "panel_session_user_id_idx" ON "panel_session"("user_id");

-- CreateIndex
CREATE INDEX "panel_session_expires_at_idx" ON "panel_session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_token_user_id_idx" ON "password_reset_token"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_credential_token_hash_key" ON "api_credential"("token_hash");

-- CreateIndex
CREATE INDEX "api_credential_principal_id_idx" ON "api_credential"("principal_id");

-- CreateIndex
CREATE INDEX "ix_audit_log_created_at_id" ON "audit_log"("created_at", "id");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_testrail_project_connection_external" ON "testrail_project"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "testrail_suite_project_id_idx" ON "testrail_suite"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_testrail_suite_connection_external" ON "testrail_suite"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "testrail_section_suite_id_parent_id_idx" ON "testrail_section"("suite_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_testrail_section_connection_external" ON "testrail_section"("connection_id", "tr_section_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_testrail_section_id_suite" ON "testrail_section"("id", "suite_id");

-- CreateIndex
CREATE INDEX "ix_testrail_case_section_title_id" ON "testrail_case"("section_id", "title", "id");

-- CreateIndex
CREATE INDEX "testrail_case_suite_id_idx" ON "testrail_case"("suite_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_testrail_case_connection_external" ON "testrail_case"("connection_id", "tr_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_case_revision_case_revision" ON "case_revision"("case_id", "revision");

-- CreateIndex
CREATE INDEX "testrail_sync_run_connection_id_started_at_idx" ON "testrail_sync_run"("connection_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_testrail_case_staging_run_case" ON "testrail_case_staging"("sync_run_id", "tr_case_id");

-- CreateIndex
CREATE INDEX "catalog_revision_status_started_at_idx" ON "catalog_revision"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_automated_test_stable_key" ON "automated_test"("stable_key");

-- CreateIndex
CREATE INDEX "automated_test_status_title_id_idx" ON "automated_test"("status", "title", "id");

-- CreateIndex
CREATE INDEX "automated_test_tags_idx" ON "automated_test" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "test_case_link_case_id_idx" ON "test_case_link"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_test_case_link_test_case" ON "test_case_link"("automated_test_id", "case_id");

-- CreateIndex
CREATE INDEX "suite_name_id_idx" ON "suite"("name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_test_user_environment_label" ON "test_user"("environment_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_setting_key_key" ON "runtime_setting"("key");

-- CreateIndex
CREATE INDEX "schedule_enabled_deleted_at_idx" ON "schedule"("enabled", "deleted_at");

-- CreateIndex
CREATE INDEX "schedule_environment_id_idx" ON "schedule"("environment_id");

-- CreateIndex
CREATE INDEX "schedule_revision_schedule_id_created_at_idx" ON "schedule_revision"("schedule_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_schedule_revision_schedule_revision" ON "schedule_revision"("schedule_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ux_schedule_occurrence_run" ON "schedule_occurrence"("run_id");

-- CreateIndex
CREATE INDEX "schedule_occurrence_scheduled_for_idx" ON "schedule_occurrence"("scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "ux_schedule_occurrence_schedule_instant" ON "schedule_occurrence"("schedule_id", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_cursor_schedule_id_key" ON "reconciliation_cursor"("schedule_id");

-- CreateIndex
CREATE INDEX "exclusion_window_starts_at_ends_at_idx" ON "exclusion_window"("starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "ix_run_environment_created_id" ON "run"("environment_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "run_status_idx" ON "run"("status");

-- CreateIndex
CREATE INDEX "run_schedule_id_status_idx" ON "run"("schedule_id", "status");

-- CreateIndex
CREATE INDEX "run_created_at_id_idx" ON "run"("created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_run_testrail_target_run_suite" ON "run_testrail_target"("run_id", "testrail_suite_id");

-- CreateIndex
CREATE INDEX "run_shard_status_idx" ON "run_shard"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ux_run_shard_run_key" ON "run_shard"("run_id", "shard_key");

-- CreateIndex
CREATE UNIQUE INDEX "worker_lease_token_hash_key" ON "worker_lease"("token_hash");

-- CreateIndex
CREATE INDEX "worker_lease_expires_at_idx" ON "worker_lease"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_worker_lease_shard_generation" ON "worker_lease"("run_shard_id", "generation");

-- CreateIndex
CREATE INDEX "run_result_run_id_status_idx" ON "run_result"("run_id", "status");

-- CreateIndex
CREATE INDEX "run_result_automated_test_id_created_at_idx" ON "run_result"("automated_test_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_run_result_run_test_param" ON "run_result"("run_id", "automated_test_id", "parameter_key");

-- CreateIndex
CREATE UNIQUE INDEX "ux_test_attempt_result_attempt" ON "test_attempt"("run_result_id", "attempt_no");

-- CreateIndex
CREATE INDEX "case_result_case_id_created_at_idx" ON "case_result"("case_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_case_result_run_case" ON "case_result"("run_id", "case_id");

-- CreateIndex
CREATE INDEX "capacity_reservation_run_id_idx" ON "capacity_reservation"("run_id");

-- CreateIndex
CREATE INDEX "capacity_reservation_expires_at_idx" ON "capacity_reservation"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ux_idempotency_key_actor_key" ON "idempotency_key"("actor_key", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ux_outbox_delivery_dedup_key" ON "outbox_delivery"("dedup_key");

-- CreateIndex
CREATE INDEX "ix_outbox_delivery_status_next_attempt" ON "outbox_delivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_delivery_target_id_sequence_idx" ON "outbox_delivery"("target_id", "sequence");

-- CreateIndex
CREATE INDEX "outbox_delivery_run_id_idx" ON "outbox_delivery"("run_id");

-- CreateIndex
CREATE INDEX "event_log_created_at_idx" ON "event_log"("created_at");

-- CreateIndex
CREATE INDEX "event_log_run_id_seq_idx" ON "event_log"("run_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ux_artifact_storage_key" ON "artifact"("storage_key");

-- CreateIndex
CREATE INDEX "artifact_run_id_kind_idx" ON "artifact"("run_id", "kind");

-- CreateIndex
CREATE INDEX "artifact_expires_at_idx" ON "artifact"("expires_at");

-- CreateIndex
CREATE INDEX "recording_session_created_by_status_idx" ON "recording_session"("created_by", "status");

-- CreateIndex
CREATE INDEX "recording_session_expires_at_idx" ON "recording_session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_credential_id_key" ON "device"("credential_id");

-- CreateIndex
CREATE INDEX "device_user_id_idx" ON "device"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_authorization_device_code_hash_key" ON "device_authorization"("device_code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "device_authorization_user_code_key" ON "device_authorization"("user_code");

-- CreateIndex
CREATE INDEX "device_authorization_expires_at_idx" ON "device_authorization"("expires_at");

-- CreateIndex
CREATE INDEX "ix_perf_sample_env_endpoint_source_ts" ON "perf_sample"("environment_id", "endpoint_key", "source", "ts");

-- CreateIndex
CREATE INDEX "perf_sample_ts_idx" ON "perf_sample"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "ux_perf_sample_run_sample_key" ON "perf_sample"("run_id", "sample_key");

-- CreateIndex
CREATE INDEX "perf_hourly_aggregate_bucket_start_idx" ON "perf_hourly_aggregate"("bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "ux_perf_hourly_series_bucket" ON "perf_hourly_aggregate"("environment_id", "endpoint_key", "provenance", "source", "metric_kind", "cache_mode", "worker_profile", "bucket_start");

-- CreateIndex
CREATE INDEX "perf_threshold_environment_id_enabled_idx" ON "perf_threshold"("environment_id", "enabled");

-- CreateIndex
CREATE INDEX "event_mark_environment_id_ts_idx" ON "event_mark"("environment_id", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "ux_alert_fingerprint" ON "alert"("fingerprint");

-- CreateIndex
CREATE INDEX "alert_status_kind_idx" ON "alert"("status", "kind");

-- CreateIndex
CREATE INDEX "alert_created_at_id_idx" ON "alert"("created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channel_kind_key" ON "notification_channel"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_user_id_key" ON "notification_preference"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_notification_schedule_sub" ON "notification_schedule_subscription"("user_id", "schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_notification_threshold_sub" ON "notification_threshold_subscription"("user_id", "threshold_id");

-- CreateIndex
CREATE INDEX "export_job_created_by_created_at_idx" ON "export_job"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "generation_request_created_by_created_at_idx" ON "generation_request"("created_by", "created_at");

-- AddForeignKey
ALTER TABLE "panel_session" ADD CONSTRAINT "panel_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credential" ADD CONSTRAINT "api_credential_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "panel_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_credential" ADD CONSTRAINT "api_credential_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_project" ADD CONSTRAINT "testrail_project_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "testrail_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_suite" ADD CONSTRAINT "testrail_suite_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "testrail_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_suite" ADD CONSTRAINT "testrail_suite_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "testrail_project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_section" ADD CONSTRAINT "testrail_section_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "testrail_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_section" ADD CONSTRAINT "testrail_section_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "testrail_suite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_section" ADD CONSTRAINT "testrail_section_parent_id_suite_id_fkey" FOREIGN KEY ("parent_id", "suite_id") REFERENCES "testrail_section"("id", "suite_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "testrail_case" ADD CONSTRAINT "testrail_case_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "testrail_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_case" ADD CONSTRAINT "testrail_case_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "testrail_section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_case" ADD CONSTRAINT "testrail_case_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "testrail_suite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_revision" ADD CONSTRAINT "case_revision_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "testrail_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_sync_run" ADD CONSTRAINT "testrail_sync_run_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "testrail_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_sync_run" ADD CONSTRAINT "testrail_sync_run_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testrail_case_staging" ADD CONSTRAINT "testrail_case_staging_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "testrail_sync_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_revision" ADD CONSTRAINT "catalog_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automated_test" ADD CONSTRAINT "automated_test_catalog_revision_id_fkey" FOREIGN KEY ("catalog_revision_id") REFERENCES "catalog_revision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_link" ADD CONSTRAINT "test_case_link_automated_test_id_fkey" FOREIGN KEY ("automated_test_id") REFERENCES "automated_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_link" ADD CONSTRAINT "test_case_link_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "testrail_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_link" ADD CONSTRAINT "test_case_link_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suite" ADD CONSTRAINT "suite_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_user" ADD CONSTRAINT "test_user_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_setting" ADD CONSTRAINT "runtime_setting_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "suite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_revision" ADD CONSTRAINT "schedule_revision_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_revision" ADD CONSTRAINT "schedule_revision_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_occurrence" ADD CONSTRAINT "schedule_occurrence_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_occurrence" ADD CONSTRAINT "schedule_occurrence_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_cursor" ADD CONSTRAINT "reconciliation_cursor_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exclusion_window" ADD CONSTRAINT "exclusion_window_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exclusion_window" ADD CONSTRAINT "exclusion_window_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exclusion_window" ADD CONSTRAINT "exclusion_window_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_suite_id_fkey" FOREIGN KEY ("suite_id") REFERENCES "suite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_catalog_revision_id_fkey" FOREIGN KEY ("catalog_revision_id") REFERENCES "catalog_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_created_by_credential_id_fkey" FOREIGN KEY ("created_by_credential_id") REFERENCES "api_credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_testrail_target" ADD CONSTRAINT "run_testrail_target_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_testrail_target" ADD CONSTRAINT "run_testrail_target_testrail_suite_id_fkey" FOREIGN KEY ("testrail_suite_id") REFERENCES "testrail_suite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_shard" ADD CONSTRAINT "run_shard_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_lease" ADD CONSTRAINT "worker_lease_run_shard_id_fkey" FOREIGN KEY ("run_shard_id") REFERENCES "run_shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_result" ADD CONSTRAINT "run_result_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_result" ADD CONSTRAINT "run_result_automated_test_id_fkey" FOREIGN KEY ("automated_test_id") REFERENCES "automated_test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_result" ADD CONSTRAINT "run_result_run_shard_id_fkey" FOREIGN KEY ("run_shard_id") REFERENCES "run_shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_result" ADD CONSTRAINT "run_result_owner_lease_id_fkey" FOREIGN KEY ("owner_lease_id") REFERENCES "worker_lease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_attempt" ADD CONSTRAINT "test_attempt_run_result_id_fkey" FOREIGN KEY ("run_result_id") REFERENCES "run_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_attempt" ADD CONSTRAINT "test_attempt_worker_lease_id_fkey" FOREIGN KEY ("worker_lease_id") REFERENCES "worker_lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_result" ADD CONSTRAINT "case_result_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_result" ADD CONSTRAINT "case_result_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "testrail_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_result" ADD CONSTRAINT "case_result_run_testrail_target_id_fkey" FOREIGN KEY ("run_testrail_target_id") REFERENCES "run_testrail_target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservation" ADD CONSTRAINT "capacity_reservation_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservation" ADD CONSTRAINT "capacity_reservation_run_shard_id_fkey" FOREIGN KEY ("run_shard_id") REFERENCES "run_shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservation" ADD CONSTRAINT "capacity_reservation_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_reservation" ADD CONSTRAINT "capacity_reservation_test_user_id_fkey" FOREIGN KEY ("test_user_id") REFERENCES "test_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "run_testrail_target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_result_id_fkey" FOREIGN KEY ("run_result_id") REFERENCES "run_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_test_attempt_id_fkey" FOREIGN KEY ("test_attempt_id") REFERENCES "test_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_session" ADD CONSTRAINT "recording_session_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "testrail_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_session" ADD CONSTRAINT "recording_session_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_session" ADD CONSTRAINT "recording_session_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_session" ADD CONSTRAINT "recording_session_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "api_credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_authorization" ADD CONSTRAINT "device_authorization_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_authorization" ADD CONSTRAINT "device_authorization_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perf_sample" ADD CONSTRAINT "perf_sample_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perf_sample" ADD CONSTRAINT "perf_sample_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perf_hourly_aggregate" ADD CONSTRAINT "perf_hourly_aggregate_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perf_threshold" ADD CONSTRAINT "perf_threshold_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perf_threshold" ADD CONSTRAINT "perf_threshold_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_mark" ADD CONSTRAINT "event_mark_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_mark" ADD CONSTRAINT "event_mark_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_threshold_id_fkey" FOREIGN KEY ("threshold_id") REFERENCES "perf_threshold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_schedule_subscription" ADD CONSTRAINT "notification_schedule_subscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_schedule_subscription" ADD CONSTRAINT "notification_schedule_subscription_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_threshold_subscription" ADD CONSTRAINT "notification_threshold_subscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "panel_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_threshold_subscription" ADD CONSTRAINT "notification_threshold_subscription_threshold_id_fkey" FOREIGN KEY ("threshold_id") REFERENCES "perf_threshold"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_request" ADD CONSTRAINT "generation_request_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "testrail_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_request" ADD CONSTRAINT "generation_request_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recording_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_request" ADD CONSTRAINT "generation_request_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "panel_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- KATALYST HAND-WRITTEN: restricciones que Prisma no puede expresar (documentadas en schema.prisma).
-- Al generar migraciones futuras con `prisma migrate dev --create-only`, revisar y ELIMINAR cualquier
-- DROP INDEX/CONSTRAINT de estos objetos (Prisma no los conoce). Ver docs/decisiones.md.
-- =============================================================================

-- ESP §7/§13.3: como máximo un lease vigente por shard.
CREATE UNIQUE INDEX "ux_worker_lease_active_per_shard"
  ON "worker_lease" ("run_shard_id")
  WHERE "revoked_at" IS NULL AND "released_at" IS NULL;

-- ESP §7: un propietario activo por test/variante (un intento en curso por run_result).
CREATE UNIQUE INDEX "ux_test_attempt_running_per_result"
  ON "test_attempt" ("run_result_id")
  WHERE "status" = 'corriendo';

-- RF-PRG-04: máximo una corrida activa o en cola por programación.
CREATE UNIQUE INDEX "ux_run_active_per_schedule"
  ON "run" ("schedule_id")
  WHERE "schedule_id" IS NOT NULL
    AND "status" IN ('en_cola', 'preparando', 'corriendo', 'finalizando', 'cancelando');

-- ESP §13.3/§13.5: reserva atómica de capacidad (slot libre por alcance) y una reserva vigente por shard/alcance.
CREATE UNIQUE INDEX "ux_capacity_reservation_slot_active"
  ON "capacity_reservation" ("scope", "scope_key", "slot")
  WHERE "released_at" IS NULL;
CREATE UNIQUE INDEX "ux_capacity_reservation_shard_scope"
  ON "capacity_reservation" ("run_shard_id", "scope")
  WHERE "released_at" IS NULL AND "run_shard_id" IS NOT NULL;
ALTER TABLE "capacity_reservation"
  ADD CONSTRAINT "ck_capacity_reservation_scope" CHECK ("scope" IN ('global', 'environment', 'test_user')),
  ADD CONSTRAINT "ck_capacity_reservation_slot" CHECK ("slot" >= 0);

-- Identidad: sujeto OIDC único si existe; correo normalizado (ESP §7 "Correos normalizados únicos").
CREATE UNIQUE INDEX "ux_panel_user_auth_subject"
  ON "panel_user" ("auth_subject")
  WHERE "auth_subject" IS NOT NULL;
ALTER TABLE "panel_user"
  ADD CONSTRAINT "ck_panel_user_email_lower" CHECK ("email" = lower(btrim("email")));

-- Nombre de ambiente único (sin distinguir mayúsculas) entre ambientes no deshabilitados.
CREATE UNIQUE INDEX "ux_environment_name_active"
  ON "environment" (lower("name"))
  WHERE "disabled_at" IS NULL;
ALTER TABLE "environment"
  ADD CONSTRAINT "ck_environment_max_concurrency" CHECK ("max_concurrency" BETWEEN 1 AND 32);

-- RF-EJE-01/RF-EJE-05: reintentos 0..2.
ALTER TABLE "run" ADD CONSTRAINT "ck_run_retries" CHECK ("retries" BETWEEN 0 AND 2);
ALTER TABLE "schedule" ADD CONSTRAINT "ck_schedule_retries" CHECK ("retries" BETWEEN 0 AND 2);
ALTER TABLE "schedule" ADD CONSTRAINT "ck_schedule_cron_nonempty" CHECK (cardinality("cron_expressions") >= 1);

-- ESP §7: parameter_key no nulo (default 'default') y con formato estable.
ALTER TABLE "run_result"
  ADD CONSTRAINT "ck_run_result_parameter_key" CHECK ("parameter_key" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  ADD CONSTRAINT "ck_run_result_counters" CHECK ("retry_count" BETWEEN 0 AND 2 AND "infra_recovery_count" BETWEEN 0 AND 1);
ALTER TABLE "test_attempt" ADD CONSTRAINT "ck_test_attempt_no" CHECK ("attempt_no" >= 1);

-- RF-PRG-05: ventana válida.
ALTER TABLE "exclusion_window" ADD CONSTRAINT "ck_exclusion_window_range" CHECK ("ends_at" > "starts_at");

-- ESP §13.8: piso de min_samples por métrica y unidades explícitas.
ALTER TABLE "perf_threshold"
  ADD CONSTRAINT "ck_perf_threshold_min_samples" CHECK (
    ("metric" = 'max' AND "min_samples" >= 1) OR ("metric" <> 'max' AND "min_samples" >= 20)
  ),
  ADD CONSTRAINT "ck_perf_threshold_unit" CHECK (
    ("metric" IN ('p95', 'max') AND "unit" = 'ms') OR
    ("metric" IN ('error_rate', 'timeout_rate') AND "unit" = 'ratio' AND "limit" BETWEEN 0 AND 1)
  ),
  ADD CONSTRAINT "ck_perf_threshold_window" CHECK ("window_min" >= 5);

-- ESP §13.8: sin duraciones/tamaños negativos; timeout es observación censurada (total_ms NULL).
ALTER TABLE "perf_sample"
  ADD CONSTRAINT "ck_perf_sample_nonneg" CHECK (
    coalesce("total_ms", 0) >= 0 AND coalesce("ttfb_ms", 0) >= 0 AND coalesce("download_ms", 0) >= 0 AND
    coalesce("bytes_wire", 0) >= 0 AND coalesce("bytes_body", 0) >= 0 AND
    coalesce("censored_at_ms", 0) >= 0 AND coalesce("timeout_limit_ms", 0) >= 0
  ),
  ADD CONSTRAINT "ck_perf_sample_timeout_censored" CHECK (NOT "timeout" OR ("total_ms" IS NULL AND "censored"));

-- RF-USR-03: credencial de usuario XOR de servicio.
ALTER TABLE "api_credential"
  ADD CONSTRAINT "ck_api_credential_principal" CHECK (("principal_id" IS NULL) <> ("service_name" IS NULL));

-- ESP §7: sección no es su propio padre; misma suite garantizada por FK compuesta testrail_section_parent_id_suite_id_fkey.
ALTER TABLE "testrail_section" ADD CONSTRAINT "ck_testrail_section_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- Outbox: intentos no negativos.
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "ck_outbox_delivery_attempts" CHECK ("attempts" >= 0);

-- Idempotencia: estados válidos.
ALTER TABLE "idempotency_key" ADD CONSTRAINT "ck_idempotency_key_state" CHECK ("state" IN ('en_proceso', 'completada'));

-- ESP §13.8 / D-016: censura ⇔ timeout; over_29s solo para respuestas completadas > 29 000 ms.
ALTER TABLE "perf_sample"
  ADD CONSTRAINT "ck_perf_sample_censored_timeout" CHECK ("censored" = "timeout"),
  ADD CONSTRAINT "ck_perf_sample_over_29s" CHECK (NOT "over_29s" OR (NOT "timeout" AND "total_ms" > 29000));
