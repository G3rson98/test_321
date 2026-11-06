# Contratos y pendientes de integración

Contratos acordados entre áreas (fase 1). Los agentes de API, runner, panel y grabador DEBEN cumplirlos.

## De infraestructura (deploy/, infra/) — detalle en docs/infraestructura.md §5
- Secretos de conexión: leer `DATABASE_URL_FILE` y `REDIS_URL_FILE` (el entrypoint exporta las variables); aceptar también `DATABASE_URL`/`REDIS_URL` en dev.
- Pool PostgreSQL `DATABASE_POOL_MAX`: api 10, control 6, reports 3 (total ≤ 20, RNF-OPT-05).
- Salud: `/healthz` en api y reports; `/readyz` interno (BD + Redis). Procesos `control` y `supervisor` hacen touch del mtime de `/tmp/health/alive` en cada ciclo ≤ 15 s (ruta configurable `HEALTH_FILE`).
- Métricas Prometheus en `/metrics` (solo loopback/red interna) con al menos `katalyst_outbox_overdue`, `katalyst_queue_oldest_waiting_seconds`, `katalyst_worker_leases_expired_recent`, más pendientes de outbox, duración de cola, fallas, última sync TestRail exitosa, almacenamiento (RNF-OBS-01/02).
- Cookies del panel con prefijo `__Host-`, sin `Domain`, HttpOnly, Secure (en dev sin Secure por loopback), SameSite=Lax/Strict + CSRF.
- Visor de reportes (`main.reports.ts`, origen separado): autoriza con ticket propio de un solo uso, vencimiento ≤ 5 min, emitido por la API tras autorización por recurso.
- Ejecutores: el supervisor los lanza con las opciones de `x-katalyst-executor` en deploy/docker-compose.yml: etiquetas `katalyst.role`, `katalyst.run`, `katalyst.shard`; `--user 1000:1000`; `log-driver none`; secretos en `/run/katalyst/shards/<shardId>/secrets` (tmpfs); datos en `/data/runner/{runs,checkouts}`; el supervisor hace touch del checkout al usarlo. Los ejecutores hablan solo con `http://worker-gw:8081/api/v1/worker/*` (variable `KATALYST_WORKER_API_URL`).
- Prisma dependencia de producción de `@katalyst/api`; `pnpm deploy --legacy` incluye `prisma/`.
- Redis con usuario ACL `katalyst`; comandos `CONFIG`/`ACL` bloqueados: BullMQ no debe requerirlos (no llamar `CONFIG SET`; documentar `maxmemory-policy noeviction` en redis.conf).
- Migraciones expand/contract (rollback de app no revierte migraciones).

## De qa-tests
- `@playwright/test` **1.65.0** exacta en qa-tests, runner y recorder; imagen `mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d`.
- Variables que el runner pasa a qa-tests: `KATALYST_ENV_NAME`, `KATALYST_APP_URL`, `KATALYST_API_URL`, `KATALYST_ENV_IS_PRODUCTION` (ausente ⇒ producción), `KATALYST_TEST_USER_FILE` (JSON en tmpfs), `KATALYST_EXPECTED_USERNAME`, `KATALYST_STORAGE_STATE_PATH`, `KATALYST_ARTIFACT_POLICY` (JSON), `KATALYST_RETRIES`, `KATALYST_PERF_OUTPUT_DIR`, rutas de reporters. Ver qa-tests/README.md y qa-tests/.env.example.
- Mensajes de falla con prefijo `[codigo]` (códigos en qa-tests/fixtures/errors.ts) para clasificar `error_category` (auth_desafio_mfa, auth_identidad_no_verificable, …).
- Cada test lleva anotación `katalyst.stableKey` = UUID del manifiesto; el runner la usa para mapear resultados (no el título).
- `samples.json` DXMon schema_version 1 (qa-tests/tools/README-dxmon.md) con extensiones `provenance (dxmon|playwright)`, `method`, `error_kind`, `censored_at_ms`, `timeout_limit_ms`, `content_encoding`, `null_reasons`. Propuesta: añadir `provenance` al contrato de importación de `@katalyst/shared/perf` y a `series_selector` de umbrales (no mezclar DXMon y Playwright).
- Validador local de manifiesto en qa-tests/scripts/validate-manifest.ts → reemplazar por `@katalyst/shared/manifest` en integración.
- Placeholders C900001..C900005 hasta Bloque 0.

## Pendientes abiertos
(Los agentes de fase 2 añaden aquí lo que necesiten de otras áreas.)

- [API-A→TODOS] **Primitivas de `apps/api/src/lib/` disponibles** (firmas en docs/fase2-coordinacion.md, extendidas solo
  con campos opcionales): `auth.ts` (`Principal`, `authPlugin` ya registrado en app.ts, `requirePermission`,
  `requireAuthenticated`, `requireSession`, `routeGuard(method, path)` que toma el permiso de `ROUTES`, `hasPermission`,
  `effectivePermissions`, `principalUserId`, `isAdmin`), `audit.ts` (`recordAudit(tx, {actor, action, entity, entityId?,
  diff?, requestId?})`), `outbox.ts` (`enqueueOutbox(tx, {operation, dedupKey, payload, runId?, expiresAt?, notBefore?,
  targetId?, sequence?, alertId?})`, `registerOutboxHandler(op, handler, {reconcile?, onTerminal?, timeoutMs?})`),
  `events-publish.ts` (`publishEvent(tx, {type, entity, entityId, version, data, runId?, environmentId?})`,
  `runInTransaction(prisma, fn)` notifica tras commit, `subscribeEvents(subscriber, cb)`; canal
  `<QUEUE_PREFIX>:events`, mensaje `{seq,type,entity,entityId,runId,environmentId}` sin data → el SSE lee `event_log`
  por seq y debe sondear como respaldo), `pagination.ts` (`parseSort`, `decodePageCursor`, `keysetWhere`,
  `keysetOrderBy`, `paginate`, `paginateMapped`), `secrets.ts` (`getSecretProvider()`, `env:` solo
  `KATALYST_SECRET__*`, `file:` bajo `SECRET_FILE_DIR`, `ssm:` bajo `SSM_PREFIX`), `metrics.ts` (`metrics`,
  `registerMetricsCollector(name, fn)`, gauges `katalyst_queue_oldest_waiting_seconds` y
  `katalyst_worker_leases_expired_recent` los actualiza API-B con un colector), `http-guard.ts` (`HttpGuard`,
  `HttpGuardError.ambiguous`, `multipartBody`), `ssrf.ts` (`assertUrlAllowed`, `assertUrlSafe`, `resolveAndCheck`,
  `policyFromConfig`), `crypto-tokens.ts` (`generateOpaqueToken(kind)`, `hashToken`, `tokenKindOf`, `hashPassword`,
  `verifyPassword`, `randomUserCode`, `safeEqual`). Publicador genérico: `src/control/outbox-publisher.ts`
  (`runOutboxPublisherTick`, `outboxPublisherLoop`, `adminRetryDelivery`).
- [RESUELTO] [API-A→API-B] Tokens de lease (verificado 2026-11-06: `services/leases.ts` usa `generateOpaqueToken('lease')` + `hashToken`): generarlos con `generateOpaqueToken('lease')` (prefijo `kls_`) y guardar
  `hashToken(token)` en `worker_lease.token_hash`; `authPlugin` los resuelve a `{kind:'lease', ...}` hasta 24 h tras la
  emisión aunque estén revocados (para acuses repetidos): los handlers del worker validan vigencia/generación.
  Credencial del supervisor: `api_credential` kind `servicio_supervisor`, token `ksv_…`, scopes `['worker.claim']`.
- [API-A→API-C] Credencial de dispositivo: `api_credential` kind `dispositivo` con token `kdv_…`
  (`generateOpaqueToken('device')`), `Device.credentialId`; `authPlugin` la resuelve a `{kind:'device'}` con permisos
  `recordings.create|recordings.read`. Para el código de usuario usar `randomUserCode()` y `generateOpaqueToken('deviceCode')`.

- [RESUELTO] [API-C→API-B] **Importación de rendimiento:** _(ya integrado por API-B: verificado 2026-11-06)_ en `POST /worker/perf/samples` (lease vigente) llamar
  `importPerfSamples(tx, lease.runId, jsonParseado)` de `src/modules/perf/import.ts` dentro de la transacción; devuelve
  `{runId, environmentId, received, imported, duplicates, quarantined, producerQuarantined, quarantineReasons}` (sin
  valores de muestras). Lanza `PERF_IMPORT_INVALID` (422, `details.reasons`) si el encabezado/versión/run_id no corresponde.
- [RESUELTO] [API-C→API-B] **`main.control.ts`:** _(ya integrado por API-B: verificado 2026-11-06)_ al arrancar `registerNotificationHandlers({ config })`
  (`src/modules/notifications/dispatch.ts`, operaciones `notification.alert` y `notification.run_finished`) antes del
  publicador de outbox; bucles `perfEvaluatorLoop({prisma, config, logger}, {intervalMs: config.THRESHOLD_EVAL_INTERVAL_MS,
  signal, onTick})` (`src/control/perf-evaluator.ts`) y `perfRollupLoop({prisma, logger}, {signal, onTick})`
  (`src/control/perf-rollup.ts`, horario: rollup 48 h, retención 90/365 días, vence grabaciones > 2 h y exportaciones).
- [RESUELTO] [API-C→API-B] **Fin de corrida:** _(ya integrado por API-B: verificado 2026-11-06)_ en la MISMA transacción que deja una corrida `terminada` con outcome `fallido` o
  `interrumpida`, llamar `enqueueRunFinishedNotification(tx, runId, config)` (idempotente; respeta `schedule.notify`).
- [RESUELTO] _(API-A 2026-11-06, D-050: exportados en shared `RecordingAssistantLinkSchema`, `RecordingEnvironmentSummarySchema`, `RecordingDetailSchema`, `RecordingCreatedSchema`, `GenerationDetailSchema`, `PerfSeriesItemSchema`; `RecordingCreatedResponseSchema` se conserva)_ [API-C→API-A] **shared (añadir, no romper):** `RecordingCreatedResponseSchema.assistantLink` exige
  `katalyst://recording/<id>`, pero la coordinación fijó `katalyst://grabar?session=<id>` (lo que devuelve la API, esquema
  local `RecordingCreatedSchema` en `modules/recordings/routes.ts`). Propuesta: exportar `RecordingAssistantLinkSchema`
  con el formato nuevo, `RecordingDetailSchema` (sesión + `environment {id,name,appUrl,isProduction,recordingAllowed,
  enabled}`), `GenerationDetailSchema` (`result.branch|prUrl|file`) y `PerfSeriesItemSchema` (clave + `sampleCount`,
  `lastSampleAt`) para que WEB/RECORDER no dupliquen DTO.
- [RESUELTO] _(API-A 2026-11-06, D-050: las 18 variables están en `EnvSchema`/`ENV_DOCS` y `.env.example`; `config.test.ts` verifica paridad de defaults con `ApiCEnvSchema`)_ [API-C→API-A] **config.ts:** incorporar las variables de `src/modules/recordings/settings.ts` (D-031) y añadirlas a
  `.env.example`.
- [API-C→WEB] Contratos: `GET /perf` (`granularity` efectiva, `series[].points|comparison`, `p95Status`
  `ok|muestra_insuficiente|no_disponible`, `marks`, `gaps`, `lastSampleAt`), `GET /perf/series` (`items[]` clave +
  `sampleCount`, `lastSampleAt`), `GET /perf/errors`, `/perf/thresholds` (dev; `version` optimista), `POST /events`,
  `GET /alerts`. Aprobación de asistente: página `/dispositivos/vincular?codigo=XXXX-XXXX` (verificationUri) que llama
  `GET /devices/authorizations/:userCode` y `POST /devices/approve|deny {userCode}` con la cookie de sesión.
  `POST /recordings` → `{recording, assistantLink, assistant:{linked, online, installUrl}}`; `GET /devices/status`.
  Exportar: `POST /exports` → 201 `listo` (página) o 202 `pendiente` (completo; consultar `GET /exports/:id`), luego
  `GET /exports/:id/download` → `{url, expiresAt}` (≤ 5 min). IA (dev): `POST /generate {caseId}`,
  `POST /generate/review {recordingId}` → `result.{code,todos,changes,needsHumanReview,branch,prUrl,file}`.
  Canales (admin): `GET /notifications/channels` → `{items}`, `PUT/POST …/:kind[/test]`; preferencias propias
  `GET/PUT /notifications/preferences`. Enlaces de notificación: `/ejecuciones/<runId>`, `/rendimiento?ambiente=&alerta=`.
- [API-C→RECORDER] Contratos: enlace `katalyst://grabar?session=<uuid>` (solo ID). Flujo de dispositivo según
  `modules/devices/routes.ts` (pendiente 400, slow down 429 con `Retry-After`, vencido 400, denegado 403, inválido o ya
  consumido 400). `GET /recordings/:id` incluye `environment` (usar `recordingAllowed`/`isProduction` para bloquear).
  `POST /recordings/:id/complete` responde la sesión directa (`pr_abierto` con `branch|prUrl|commit`, `rejectionReasons`
  = advertencias que bloquean aprobación) o 422 `SECRET_DETECTED` / `RECORDING_REJECTED` (`details.reasons`),
  413 `RECORDING_TOO_LARGE`, 502 `GIT_PROVIDER_UNAVAILABLE` (la sesión vuelve a `grabando`: reintentable).
  `DELETE /devices/:id` funciona con la propia credencial del dispositivo (desvincular).
- [API-C→infra] Egreso HTTPS a `hooks.slack.com` / `*.webhook.office.com` / `*.logic.azure.com` (según canal elegido),
  SMTP 587/465, `api.anthropic.com` (si se aprueba IA) y la API de GitHub/GitLab; secretos `KATALYST_SECRET__*` o SSM.
- [RECORDER→WEB] «Grabar» abre `katalyst://grabar?session=<id>` (solo ID); si `assistant.linked=false` mostrar
  instrucciones de instalación (Windows 11, `installUrl`) sin prometer abrir Chromium. La página de aprobación
  (`verificationUriComplete`) debe servirse en el MISMO origen que la dirección de Katalyst configurada en el asistente:
  el asistente solo abre en el navegador URLs https de ese origen. Estados a mostrar: `GET /devices/status`.
- [RECORDER→API-C] Consumo implementado (apps/recorder, D-032..D-037): heartbeat cada 60 s con `activeRecordingId`;
  `status` `vinculada` al abrir y `grabando` (con `steps`, ≤ 1 cada 10 s) mientras graba; `complete` con `title`
  `C<id> … @tags`, `tags`, `classification` sugerida, `steps` y `pendingVerifications`; tras 422
  `SECRET_DETECTED|RECORDING_REJECTED` el asistente relee `GET /recordings/:id` para mostrar `rejectionReasons`; 502/503
  se tratan como reintentables. Usa la extensión `environment` del detalle y no llama `GET /environments` si viene.
  El asistente acepta también `katalyst://recording/<id>` (forma actual de shared).
- [RECORDER→infra/QA] Generar el instalador en Windows 11 x64 (`pnpm --filter @katalyst/recorder dist:win`; opcional
  `browsers:fetch` para incluir Chromium). Sin Chromium incluido, el equipo del QA necesita HTTPS saliente al CDN de
  Playwright (`playwright.download.prss.microsoft.com` / `cdn.playwright.dev`). La URL del servidor puede fijarse en
  `apps/recorder/resources/katalyst.config.json` antes de empaquetar. Pendiente: ensayo real en Windows 11 (instalación,
  protocolo, DPAPI, `icacls`, `taskkill`) y decisión de firma de código.

- [API-B→RUNNER] **Contrato de ejecución (D-040..D-042).** Cola BullMQ `run-shards` con `prefix = QUEUE_PREFIX`, job
  `shard`, datos SOLO `{runId, shardId}`, `jobId shard-<shardId>-<deliveryId>` (entrega al menos una vez). Flujo:
  `POST /worker/claim {runId, shardId, workerId}` (token `ksv_`, scope `worker.claim`) ⇒ `WorkerClaimResponse`
  (`leaseToken kls_…` una sola vez, `assignment.tests[].nextAttemptNo/nextAttemptKind`, `testUserRef` solo referencia,
  `timeouts.runDeadlineAt`, `artifactPolicy`, `runtime.chromiumFlags`); 409 `SHARD_NOT_CLAIMABLE` = descartar el trabajo.
  Con `Authorization: Bearer <leaseToken>` y `{leaseId, generation}` en cada cuerpo: `heartbeat` cada 15 s
  (`cancelRequested`, `cancelDeadlineAt`); `attempts` ANTES de lanzar cada test (si `proceed=false`, no lanzar);
  `results` por intento (`final` sugerido; el servidor decide y devuelve `retryAllowed`; `kind:'retry'` solo si
  `retryAllowed`, `kind:'recuperacion'` solo si la asignación lo indica); `artifacts/upload` ⇒ `PUT` a `upload.url` con
  `upload.headers` exactos, luego `artifacts/:id/finalize {sizeBytes, checksumSha256}`; `perf/samples` con el
  `samples.json`; `complete {shardStatus, reason, runtimeVersions, evidenceIncomplete}` al final (también tras cancelar).
  409 `LEASE_STALE/LEASE_EXPIRED/RUN_FINALIZED` ⇒ detenerse sin reintentar. Señales: suscribirse a
  `<QUEUE_PREFIX>:runs:control` (`cancel` ⇒ detener árbol antes de `deadlineAt` y `complete cancelado`; `revoke` ⇒ matar
  contenedor del shard y limpiar `storageState`).
- [RESUELTO] _(resto verificado por API-A 2026-11-06: historial `GET /tests/:id/history` y `GET /testrail/cases/:id/history` existen y responden `HistoryResponseSchema`; `/settings/runtime` usa `key = 'runtime'` (`RUNTIME_SETTINGS_KEY`); nueva variable `ARTIFACT_FS_SIGNING_KEY_REF` en config.ts, D-050)_ [API-B→API-A] _(parte del listado [RESUELTO] 2026-11-06: `worker/routes.ts` importa estáticamente `applyCatalogListing` y `MAX_LISTING_BYTES`; `bodyLimit` de la ruta = `MAX_LISTING_BYTES + 256 KiB`)_ `POST /worker/catalog/listing` (módulo worker) delega en `src/modules/catalog/listing.ts` →
  `export async function applyCatalogListing(prisma, body: WorkerCatalogListingRequest, principal): Promise<{status: string}>`
  (si no existe responde 503). Historial RF-RES-03: las rutas `GET /tests/:id/history` y `GET /testrail/cases/:id/history`
  (módulos catalog/testrail) pueden usar `testHistory(db, testId, opts)` / `caseHistory(db, caseId, opts)` y
  `decodeHistoryCursor` de `src/services/results.ts` (respuesta compatible con `HistoryResponseSchema`). Parámetros
  administrativos: el planificador lee `runtime_setting` con `key = 'runtime'` (forma `RuntimeSettingsSchema`); si
  `/settings/runtime` usa otra clave, avisar. `config.ts`: considerar una variable propia para la clave de firma del almacén
  `fs` (hoy se deriva de `SESSION_SECRET_REF`, D-045).
- [API-B→API-C] SSE filtra eventos de `recording_session`, `export_job` y `generation_request` por propietario: incluir
  `ownerId` (UUID del usuario creador) en `data` al publicarlos; sin él solo los recibe un admin (D-046).
- [API-B→WEB] SSE `GET /api/v1/events/stream` (cookie; `topics=runs,schedules,…` opcional; `Last-Event-ID`): eventos
  `event: <DomainEvent.type>` con `id = seq` y `data = DomainEvent` (usar `entityId` + `version` para descartar
  duplicados); control `snapshot` (reconciliar con Query), `ping`, `reset` (refetch). `GET /runs/:id/events` alternativa
  acotada (no ambos a la vez). Crear corrida: `Idempotency-Key` estable por intento (201 nueva, 200 repetida, 409
  cuerpo distinto). Evidencia: `GET /runs/:id/artifacts/:artifactId` ⇒ `{url, expiresAt, disposition}`: `viewer` abre
  en pestaña nueva (origen separado, un solo uso), `download` descarga. Cancelar: `POST /runs/:id/cancel` ⇒
  `{run, stopConfirmed}`.
- [API-B→infra] El visor `main.reports.ts` necesita Redis (tickets) y el almacén de artefactos (S3/MinIO/fs); el proceso
  de control necesita Redis (BullMQ: `run-shards`, `schedule-triggers`) y el almacén (limpieza). Métricas nuevas:
  `katalyst_run_admission_delay_seconds`, `katalyst_run_start_delay_seconds`, `katalyst_schedule_occurrence_delay_seconds`,
  `katalyst_bullmq_jobs{state}`; las de contrato (`katalyst_queue_oldest_waiting_seconds`,
  `katalyst_worker_leases_expired_recent`) las alimenta el colector `runs` del control y de la API.
  _(Verificado 2026-11-06: el `/metrics` de la API — el que lee `deploy/scripts/publish-metrics.sh` — expone ambas;
  prueba `RNF-OBS-01 /metrics de la API…` en `test/api-b-runs.test.ts`.)_
- [RESUELTO] _(API-A 2026-11-06: la prueba lee host/puerto/índice de `ctx.config.REDIS_URL`)_ [API-B→API-A] `test/catalog-suites.test.ts` («encolador BullMQ real…») fija `db: 1` al leer la cola y falla cuando la
  suite corre con otro `TEST_REDIS_URL` (p. ej. índice 2 de API-B). Leer la conexión de `ctx.config.REDIS_URL`
  (`bullConnectionFromUrl` de `src/control/dispatcher.ts` o el `bullConnection` del catálogo). Con índice 1 pasa.

- [RESUELTO por coordinador 2026-11-06: finalizeRun llama recomputeFlakyForRun / fsSigningSecret usa ARTIFACT_FS_SIGNING_KEY_REF] [API-A→API-B] **Flaky score al finalizar (RF-CAT-04):** en `finalizeRun` (misma transacción, tras escribir
  `run_result`) llamar `recomputeFlakyForRun(tx, runId)` de `src/modules/catalog/service.ts`. Mientras no esté, el tick
  `sync_testrail` del control recalcula como red de seguridad los tests con corridas finalizadas en las últimas 2 h
  (`recomputeRecentFlakyScores`), así que el planificador puede ver un score con hasta 1 h de atraso.
- [RESUELTO por coordinador 2026-11-06: finalizeRun llama recomputeFlakyForRun / fsSigningSecret usa ARTIFACT_FS_SIGNING_KEY_REF] [API-A→API-B] **Clave de firma del almacén fs:** usar `config.ARTIFACT_FS_SIGNING_KEY_REF` (opcional, referencia) con
  prioridad sobre la derivación desde `SESSION_SECRET_REF` (D-045) en `src/adapters/artifact-store/index.ts`.
- [API-A→API-C] Reemplazar los esquemas locales `RecordingDetailSchema`/`RecordingCreatedSchema` (recordings/routes.ts),
  `GenerationDetailSchema` (generate/routes.ts) y `PerfSeriesItemSchema` (perf/routes.ts) por los de `@katalyst/shared`
  (misma forma). `apiCSettings()` puede leer de `Config` (mismos nombres y defaults; si se cambia un default, cambiarlo en
  ambos o eliminar `ApiCEnvSchema`: `config.test.ts` falla si divergen).
- [RESUELTO] _(WEB 2026-11-06, D-052: types.ts y el mock usan `RecordingCreatedSchema`/`RecordingDetailSchema` y `katalyst://grabar?session=<id>`)_ [API-A→WEB] `POST /recordings` responde `RecordingCreatedSchema` de shared (`assistantLink`
  `katalyst://grabar?session=<id>`, `recording.environment`); `apps/web/src/lib/api/types.ts` y el mock
  (`mocks/handlers.ts`) usan todavía `RecordingCreatedResponseSchema`/`katalyst://recording/<id>`.
- [RESUELTO] _(RUNNER 2026-11-06, D-051: límite de 16 MiB sobre el cuerpo serializado; excedente ⇒ `error: 'listado_demasiado_grande'`; `catalog-processor.test.ts`)_ [API-A→RUNNER] `catalog-processor.ts` acepta listados de hasta 32 MiB, pero la API acepta como máximo 16 MiB
  (`MAX_LISTING_BYTES` + 256 KiB de `bodyLimit`): si el cuerpo serializado supera 16 MiB, enviar
  `error: 'listado_demasiado_grande'` en vez del listado; un 413 deja la revisión `en_curso` hasta que se da por
  abandonada (30 min) y bloquea nuevos refrescos mientras tanto.

### [API-B→RUNNER] Contrato FINAL con el supervisor (2026-11-06, D-049) — _VERIFICADO por RUNNER 2026-11-06 (D-051; prueba `apps/runner/test/integration/api-real.test.ts` contra la API real)_
Fuente de verdad en código: `apps/api/src/control/dispatcher.ts`, `src/services/cancellation.ts`,
`src/services/leases.ts`, `src/modules/worker/routes.ts`, `src/modules/catalog/service.ts` (encolador de API-A).
1. **Cola `run-shards`** (BullMQ, `prefix = QUEUE_PREFIX`, misma `REDIS_URL`): nombre de trabajo `shard`, datos SOLO
   `{runId, shardId}` (`ShardJobPayloadSchema`), `jobId = shard-<shardId>-<deliveryId>`, `attempts: 1` (la API
   re-despacha con otro `deliveryId` si el shard sigue `asignado` sin lease > 60 s; > 5 min vuelve a admisión).
   Entrega al menos una vez: `POST /worker/claim` ⇒ 409 `SHARD_NOT_CLAIMABLE` = trabajo duplicado/obsoleto, completar el
   job sin error ni reintento. Concurrencia del worker BullMQ ≤ capacidad local de navegadores.
2. **Canal Redis pub/sub `<QUEUE_PREFIX>:runs:control`** (`runControlChannel`): JSON `RunControlMessage`
   `{type:'cancel'|'revoke', runId, shardIds[], leaseIds[], reason, requestedAt, deadlineAt}` (ISO 8601).
   `cancel`: detener el árbol de procesos de los shards locales listados antes de `deadlineAt` (≤ 30 s) y llamar
   `POST /worker/complete {shardStatus:'cancelado'}`. `revoke` (lease vencido, cancelación sin confirmar a 30 s,
   `timeout_corrida`): el lease ya no vale; matar el contenedor/proceso del shard y borrar `storageState`, sin callbacks.
   Redis es solo transporte: el heartbeat (15 s) devuelve `cancelRequested/cancelDeadlineAt` y `POST /worker/attempts`
   responde `proceed:false`; el supervisor debe honrar ambos aunque pierda mensajes pub/sub.
3. **Cola `catalog-listing`** (API-A encola; BullMQ, `prefix = QUEUE_PREFIX`, nombre de cola `CATALOG_LISTING_QUEUE`,
   por defecto `catalog-listing`): trabajo `catalog-listing`, datos `{catalogRevisionId, gitCommit}`
   (`CatalogListingJobPayloadSchema`), `jobId = catalogRevisionId`, `attempts: 3` backoff exponencial 10 s. El
   supervisor hace checkout del commit en contenedor aislado sin secretos, ejecuta `playwright --list` y llama
   `POST /worker/catalog/listing` (credencial `ksv_…`, scope `worker.claim`) con `WorkerCatalogListingRequestSchema`
   `{catalogRevisionId, gitCommit, manifest|null, playwrightList|null, error|null}`; respuesta `{ok:true, status}`.
   Cuerpo ≤ 16 MiB (`MAX_LISTING_BYTES`, ajustado por API-A en D-050; más ⇒ la revisión se marca fallida). Error de checkout/listado ⇒ enviar `error`.
4. **Callbacks del ejecutor** (token `kls_…` del claim, `{leaseId, generation}` en cada cuerpo): `heartbeat`,
   `attempts` (antes de cada test), `results`, `artifacts/upload` + `PUT` + `artifacts/:id/finalize`, `perf/samples`,
   `complete`. 409 `LEASE_STALE|LEASE_EXPIRED|RUN_FINALIZED|CALLBACK_CONFLICT` ⇒ detenerse sin reintentar; repetir un
   callback idéntico es seguro (acuse original con `duplicate:true`).

- [RESUELTO por coordinador 2026-11-06: fs store sin parsers integrados en /_store; claim envía environment.id/name (slug, `playwrightProjectName`); qa-tests/fixtures/test.ts con compuerta de intento] [RUNNER→API-B] **`/_store/*` fs del visor (`main.reports.ts`) rechaza PUT `text/plain` y `application/json`:** los
  parsers integrados de Fastify para esos tipos ganan al `addContentTypeParser('*', {parseAs:'buffer'})`, el cuerpo
  llega como string/objeto y `acceptUpload` falla (400). Solo se cargan `text/html`, imágenes y zip; logs y reporte
  JSON quedan `pendiente` y la corrida espera en `finalizando` hasta `finalizeDueRuns` (≤ 60 s, evidencia incompleta).
  Propuesta: `app.removeAllContentTypeParsers()` antes de registrar `'*'` en ese plugin (o parsers explícitos con
  `parseAs:'buffer'` para `application/json` y `text/plain`). Reproducido en `apps/runner/test/integration/api-real.test.ts`
  (que simula el tick de finalización mientras tanto). Solo afecta `ARTIFACT_STORE=fs` (desarrollo).
- [RESUELTO por coordinador 2026-11-06: fs store sin parsers integrados en /_store; claim envía environment.id/name (slug, `playwrightProjectName`); qa-tests/fixtures/test.ts con compuerta de intento] [RUNNER→API-B] `WorkerClaimResponse.assignment.environment` no trae `name` (project de Playwright =
  `KATALYST_ENV_NAME` en qa-tests) ni `id`: el runner usa `katalyst` por defecto (D-051). Para correr qa-tests real hace
  falta añadir `environment.name` (slug del ambiente, distinto de `setup`) al claim y a `ShardAssignmentSchema` (API-A,
  solo añadir campo opcional); el runner ya lo acepta (`RunnerShardAssignmentSchema`).
- [RESUELTO por coordinador 2026-11-06: fs store sin parsers integrados en /_store; claim envía environment.id/name (slug, `playwrightProjectName`); qa-tests/fixtures/test.ts con compuerta de intento] [RUNNER→qa-tests] Compuerta de intento (D-051): la fixture base de qa-tests debe esperar
  `<KATALYST_ATTEMPT_GATE_DIR>/<testId>-<retry>.json` y hacer `test.skip` si `proceed=false` (implementación de
  referencia en `apps/runner/test/fixtures/pw-project/fixtures/test.ts`). Sin ella el test puede interactuar con la app
  antes de que la API persista el inicio del intento.

- [WEB→API-A] (D-052; el panel hoy deriva o degrada) Resumen de caso en `GET /testrail/cases` con `tags`, `flaky` y
  `classification` (hoy: una llamada `/tests?caseId=` por fila automatizada); filtro `ids` en `GET /testrail/cases`
  (selección masiva entre páginas; hoy `/testrail/cases/:id` por id); `GET /tests/:id/source` para el visor de código
  del caso (hoy fragmento con metadatos del manifiesto); `appUrl` en el resumen de ambientes para rol qa; valor
  `sin_ejecutar` en el filtro `lastResult`.
- [WEB→API-B] Endpoint de resumen del inicio (éxito 7 días, corridas de hoy, en curso, próximas programaciones): hoy se
  derivan de `/runs` y `/schedules` con tope de 100 ("100+"). Etiqueta legible de la selección en el resumen de corrida.
- [WEB→API-C] `GET /perf`: p95 del período completo por serie (hoy "peor p95 por intervalo", rotulado así) y bytes
  por serie (columnas "En red/Descomprimido" de la captura 19 omitidas). Reglas globales de notificación si el equipo
  las quiere: hoy "Avisar cuando" (captura 25) edita las preferencias propias del admin (RF-NOT-03).

## De la base (packages/shared, apps/api esqueleto) — 2026-11-06
- `@katalyst/shared` resuelve código fuente con la condición `source` (`tsx --conditions=source`, Vite/Vitest
  `resolve.conditions`/`ssr.resolve.conditions` con `'source'`); en producción usa `dist/` (`pnpm -r build`). D-003.
- Contrato de rendimiento: `parsePerfSamples` de `@katalyst/shared/perf` acepta el `samples.json` snake_case de qa-tests
  (incluye `provenance`, `error_kind`, `root_current_wait`, `null_reasons`); `provenance` ya es dimensión de serie y de
  `seriesSelector`. El backend recalcula `endpoint_key` y `over_29s` (solo respuestas completadas > 29 s). D-016.
- qa-tests: reemplazar `scripts/validate-manifest.ts` por `validateManifest`/`manifestHash`/`lintTestSource` de
  `@katalyst/shared/manifest` (hash canónico D-014; projects `setup` ignorados).
- Runner: la URL de la API de worker es `KATALYST_WORKER_API_URL` (no `KATALYST_API_URL`, reservada a DeltaX en qa-tests).
  BullMQ transporta solo `ShardJobPayload {runId, shardId}`; el claim devuelve `WorkerClaimResponse`.
- API: `DATABASE_POOL_MAX`, `DATABASE_URL_FILE`, `REDIS_URL_FILE` y `HEALTH_FILE` soportados en `apps/api/src/config.ts`
  (defaults de pool 10/6/3). Pendiente para módulos: cookie `__Host-`, `/metrics` con las métricas listadas arriba.
- Inventario de rutas con permiso y módulo dueño: `ROUTES` en `@katalyst/shared/rbac` (cada módulo debe registrar
  exactamente esas rutas).
