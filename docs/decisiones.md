# Registro de decisiones — Katalyst

Formato: `D-NNN — Título` · Fecha · Área · Contexto → Decisión → Consecuencias. Las decisiones abiertas de ESP §12
(región AWS, plataforma Git, canal de notificaciones, IdP, proveedor IA…) **no** se resuelven aquí: se implementan
interfaces con adaptadores configurables (plan §5 regla 6). Cada agente añade sus decisiones al final con el siguiente
número libre.

---

## D-001 — Runtime y gestor de paquetes
2026-11-06 · base
- **Decisión:** Node **24.22.2** (LTS vigente, Homebrew `node@24`), fijado en `.nvmrc` (`24`) y `.node-version`
  (`24.22.2`); `engines.node >=24.22.2 <25`. pnpm **10.34.9** vía Corepack (`packageManager: pnpm@10.34.9`).
- **Contexto:** el registro npm ofrece pnpm 12 y Node 20 está instalado en el sistema; el plan §2 fija pnpm 10 y Node 24.
- **Consecuencias:** usar `corepack enable` y `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` en macOS local.

## D-002 — Matriz de versiones fijadas (catálogo pnpm)
2026-11-06 · base
- **Decisión:** una sola versión por dependencia compartida en `pnpm-workspace.yaml` → `catalog:` (sin rangos):

| Paquete | Versión | Nota |
| --- | --- | --- |
| typescript | 5.9.3 | `latest` es 7.x; plan §2 pide 5.x y typescript-eslint 8.72 exige `<6.1` |
| zod | 4.6.7 | Zod 4 porque `fastify-type-provider-zod` 6/7 exige `zod >= 4.1.5`; única versión del repo |
| fastify | 5.12.8 | |
| fastify-type-provider-zod | 7.0.0 | publicado 2026-06; peer fastify ^5.5, @fastify/swagger ≥ 9.5.1 |
| @fastify/swagger · swagger-ui | 9.9.3 · 6.1.3 | OpenAPI en `/api/docs` |
| @fastify/cookie · cors · rate-limit · helmet | 11.1.5 · 11.4.1 · 11.2.2 · 13.2.0 | |
| fastify-plugin | 6.0.1 | la que usan los plugins oficiales |
| prisma · @prisma/client | 6.19.3 | el tag `latest` de `prisma` apunta a 8.0.0-rc (RC prohibido); plan §2 fija Prisma 6 |
| pino · pino-pretty | 9.14.0 · 13.2.0 | pino-pretty solo en desarrollo |
| ioredis · bullmq | 5.11.1 · 5.81.5 | BullMQ 5 (Job Schedulers) |
| vitest · @vitest/coverage-v8 | 3.2.7 | plan §2: Vitest 3 |
| eslint · @eslint/js | 10.14.0 · 10.0.1 | ESLint 9.39 figura como "no longer supported" en npm |
| typescript-eslint · eslint-config-prettier · prettier | 8.72.1 · 10.1.8 · 3.9.10 | |
| tsx · @types/node | 4.23.15 · 24.19.2 | |
| @playwright/test | 1.65.0 | fijado por qa-tests; runner/recorder deben usar la misma (docs/pendientes-integracion.md) |

- **Servicios locales:** PostgreSQL **16.15** (Homebrew `postgresql@16`), Redis **8.10.3** (Homebrew `redis`). El plan
  menciona Redis 7: la versión del contenedor de despliegue la fija `deploy/`; BullMQ 5 funciona con Redis ≥ 6.2.
- **Consecuencias:** paquetes nuevos de otros agentes deben usar `catalog:` para lo que ya está en el catálogo y añadir
  entradas al catálogo en lugar de versiones locales divergentes.

## D-003 — Consumo de `@katalyst/shared` sin build en desarrollo
2026-11-06 · base
- **Decisión:** `exports` condicionales con condición propia `source` → `src/*.ts`, y `types`/`import` → `dist/`.
  `tsconfig.base.json` declara `customConditions: ["source"]` (typecheck sin compilar shared); `tsx --conditions=source`
  y Vitest (`ssr.resolve.conditions`) resuelven el código fuente. Producción usa `dist/` (`pnpm -r build`, orden
  topológico; `apps/api/tsconfig.build.json` desactiva `customConditions`).
- **Consecuencias:** Vite del panel debe añadir `resolve.conditions: ['source', ...]` en dev o compilar shared.
  `@katalyst/shared` es isomórfico (sin `node:*`): usa `TextEncoder`, `btoa/atob` e `Intl`.

## D-004 — Parser de cron y servicio de ocurrencias propios
2026-11-06 · base (RF-PRG-01/02, ESP §13.5)
- **Contexto:** se evaluó `cron-parser` 5.x (luxon). Su manejo de DST no garantiza la política exigida (hora inexistente
  se omite; repetida solo la primera) y difiere entre versiones.
- **Decisión:** implementación propia en `packages/shared/src/schedule` (~400 líneas, 100 % líneas cubiertas): cron de
  5 campos con listas, rangos, pasos, nombres, domingo 0/7, macros (`@daily`…), semántica Vixie (día-mes OR
  día-semana si ambos restringidos); conversión hora local ↔ UTC con `Intl.DateTimeFormat`. Itera días civiles y, para
  cada minuto de pared que coincide, obtiene los instantes UTC posibles: 0 → se omite, 2 → solo el primero.
  Unión de expresiones deduplicada por instante UTC. Sin segundos (6 campos rechazado).
- **Consecuencias:** `nextOccurrences`, `occurrencesBetween`, `isScheduledInstant` son el **único** servicio lógico para
  vista previa, admisión y reconciliación. BullMQ solo despacha.

## D-005 — Intervalo mínimo y validación de programaciones
2026-11-06 · base
- **Decisión:** el intervalo mínimo (5 min, configurable) se mide en **hora de pared** sobre la unión de expresiones,
  incluido el cruce de medianoche, en un horizonte determinista de 8 años desde 2024-01-01 (bisiestos y combinaciones
  día/mes). La política DST solo omite/deduplica instantes; nunca los acerca por debajo del intervalo de pared.
  Máximo 20 expresiones. Códigos: `CRON_INVALID`, `TIMEZONE_INVALID`, `CRON_INTERVAL_TOO_SHORT`, `SCHEDULE_NO_OCCURRENCES`.

## D-006 — Editor visual de horario
2026-11-06 · base (RF-PRG-02)
- **Decisión:** días `0..6` (0 = domingo, como cron). Modo `intervalo` con rango **inclusivo** `start..end` y paso
  `everyMinutes`; horas con igual conjunto de minutos se agrupan en una expresión (L-V 08:00–18:00 c/30 →
  `0,30 8-17 * * 1-5` + `0 18 * * 1-5`, 21 ocurrencias). Rango con `start > end` exige `overnightDays` explícitos (días
  de la parte posterior a 00:00); sin ellos → `SCHEDULE_RANGE_CROSSES_MIDNIGHT`. El esquema de programación acepta
  exactamente uno entre `editor` y `cronExpressions` (avanzado).

## D-007 — `caseIds` de la API son UUID locales
2026-11-06 · base (ESP §9)
- **Decisión:** `caseIds` en `POST /runs`, suites y programaciones son UUID de `testrail_case`, no `C1234`.
  La forma `C<n>` (`CaseRefSchema`) se usa en títulos/manifiesto y para mostrar. Consistente con `getRowId` por UUID
  (ESP §17.3). IDs inexistentes o de otro proyecto → 422 `SELECTION_FOREIGN_IDS`.

## D-008 — Selección plana con refinamiento y forma normalizada
2026-11-06 · base
- **Decisión:** el cuerpo HTTP mantiene la forma plana de ESP §9 (`suiteId | caseIds | tags`) validada con
  `superRefine` (código `SELECTION_EXCLUSIVE`); listas con códigos `SELECTION_EMPTY`, `SELECTION_DUPLICATES`,
  `SELECTION_TOO_LARGE` (500 casos, 50 etiquetas). El snapshot y `schedule.selector` guardan la forma discriminada
  `{kind:'suite'|'cases'|'tags'}` (`normalizeSelection`). Los mensajes de issue iguales a un `ErrorCode` se elevan a ese
  código en el manejador de errores de la API.
- El selector de **suite guardada** admite unión (OR) de `caseIds`, `tags` y `sectionIds` (secciones con descendientes)
  y `excludeFlaky`.

## D-009 — Códigos de error y estados HTTP
2026-11-06 · base (ESP §9)
- **Decisión:** catálogo estable en `packages/shared/src/errors.ts` (solo se agregan códigos). Validación de esquema →
  422 `VALIDATION_FAILED` con issues sanitizados (sin valores recibidos); JSON mal formado → 400 `BAD_REQUEST`; falta de
  `Idempotency-Key` → 400 `IDEMPOTENCY_KEY_REQUIRED`; misma clave con cuerpo distinto → 409 `IDEMPOTENCY_CONFLICT`;
  callbacks con lease obsoleto → 409 `LEASE_STALE`; misma clave de callback con contenido distinto → 409
  `CALLBACK_CONFLICT`. Cuerpo: `{ error: { code, message, requestId, details? } }`.

## D-010 — Valores de enums no fijados por la ESP
2026-11-06 · base
- `test_attempt.status`: `corriendo, pasado, fallido, omitido, cancelado, error_infraestructura` (escritura en curso
  perdida = `error_infraestructura` + `error_category=resultado_desconocido`).
- `error_category`: `asercion, timeout_aplicacion, error_aplicacion` (fallas funcionales) y `login,
  navegador_no_disponible, worker_perdido, resultado_desconocido, timeout_corrida, infraestructura, politica,
  configuracion, cancelacion, desconocido`.
- `run_shard.status`: `pendiente, asignado, corriendo, completado, cancelado, interrumpido`.
- `outbox_delivery.status`: `pendiente, en_proceso, entregada, requiere_intervencion, vencida, cancelada`;
  `operation` (texto): `run.dispatch_shard`, `testrail.add_run`, `testrail.add_results_for_cases`,
  `testrail.add_attachment_to_result`, `testrail.close_run`, `notification.run_finished`, `notification.alert`.
- `artifact.sanitization_status`: `pendiente, sanitizado, deshabilitado, fallido, retenido` (solo `sanitizado` publicable).
- `case_result.status`: `pendiente, pasado, inestable, fallido, bloqueado, no_ejecutado`.
- `test_case_link.review_status`: `vigente, requiere_revision`. `alert.status`: `activa, recuperada`.
- Causas estables `ResultReason` (p. ej. `sin_automatizacion`, `escritura_en_produccion`, `revision_pendiente`,
  `variante_faltante`, `worker_perdido`, `escritura_resultado_desconocido`) y de omisión de ocurrencia
  (`solapamiento, sin_capacidad, caida_servicio, ventana_exclusion, programacion_pausada, …`).
- Todos como enums de PostgreSQL con los mismos valores (test de paridad en `apps/api/test/migration.integration.test.ts`).

## D-011 — Máquina de estados de la corrida
2026-11-06 · base (ESP §13.2)
- **Decisión:** `en_cola → preparando | terminada (todo bloqueado) | omitida (capacidad) | cancelando | cancelada |
  interrumpida`; `preparando → corriendo | finalizando | cancelando | interrumpida`; `corriendo → finalizando |
  cancelando | interrumpida`; `finalizando → terminada | cancelada | interrumpida`; `cancelando → cancelada |
  interrumpida`. Terminales sin salida. `outcome` de una `terminada` sin resultados ni casos = `bloqueado` (nunca
  exitosa).

## D-012 — Agregación por caso en corridas canceladas/interrumpidas
2026-11-06 · base (ESP §13.4)
- **Decisión:** sin falla confirmada, un caso incompleto en corrida cancelada/interrumpida queda `no_ejecutado` (sin
  resultado externo) **solo si** la incompletitud se debe a la interrupción (`cancelado`, `pendiente`, `corriendo`,
  `error_infraestructura`); si se debe a política (`bloqueado`/`omitido`) se publica Blocked. El caso sin automatización
  se publica Blocked (`sin_automatizacion`) también en corridas canceladas. Duración del caso = suma de intentos.
  Comentarios incluyen el marcador `[katalyst-run:<uuid>]` para reconciliar tras timeout ambiguo.

## D-013 — Sanitización por reglas y verificación bloqueante
2026-11-06 · base (RNF-SEG-02, ESP §13.7)
- **Decisión:** reglas por expresiones (JWT, Bearer/Basic, cookies, AWS, claves privadas, credenciales en URL,
  `clave=valor` sensibles, tokens GitHub/GitLab/Slack/Anthropic, correos, canarios `KATALYST_CANARY_*`, secretos
  conocidos literales) aplicadas a texto, URL (query/fragmento/ruta), JSON profundo (claves sensibles y pares
  `{name,value}` de encabezados), HTML (inputs, textarea, meta, atributos `data-*`, URLs) y encabezados. Se prefiere
  sobre-enmascarar. `verifySanitized` re-escanea y devuelve hallazgos **sin valores**; con hallazgos la evidencia no se
  publica (`sanitization_status=fallido`). Profundidad JSON > 64 → incompleto (bloquea). Los correos con TLD de
  extensión de archivo (`foto@2x.png`) no se consideran correo.
- **Límite:** no sanitiza binarios/píxeles (capturas/video/ZIP): eso requiere el ensayo de canarios de ESP §13.7.

## D-014 — Hash del manifiesto
2026-11-06 · base (ESP §13.1, RF-CAT-05)
- **Decisión:** SHA-256 en TypeScript puro (sincrónico, isomórfico; verificado contra `node:crypto`) sobre JSON
  canónico (claves ordenadas) del manifiesto canónico (tests por `stableKey`; `cases`, `tags`, `parameterKeys`
  ordenados). El ejecutor revalida con `manifestHash()` de `@katalyst/shared/manifest`; el validador local de qa-tests
  debe reemplazarse por éste en integración.
- El manifiesto admite `status: aprobado | retirado` (default `aprobado`). Specs de projects de infraestructura
  (`setup`, archivos `*.setup.ts`/`*.teardown.ts`) se ignoran al comparar con `playwright --list`. Las etiquetas del
  reporter JSON (sin `@`) se normalizan con `@`.

## D-015 — RBAC
2026-11-06 · base (ESP §3, §9)
- **Decisión:** permisos por recurso con rol mínimo (`packages/shared/src/rbac`). Ajustes no explícitos en la ESP:
  `environments.list` (qa) para elegir ambiente sin acceso a la administración (admin); ventanas de exclusión (dev);
  lectura de entregas de outbox (qa, RF-TR-08) y reintento (admin); `GET /perf/thresholds` dev según tabla §9;
  `servicio` disjunto (solo `worker.claim` supervisor y `worker.callback` lease). Tokens API: rol ∩ scopes.
- Rutas: las marcas de eventos usan `POST/GET /events` (ESP §9) y el SSE global `GET /events/stream`.
  Rutas de worker adicionales: `claim`, `attempts`, `artifacts/:id/finalize`, `perf/samples`, `complete`,
  `catalog/listing`. Inventario completo en `ROUTES`.

## D-016 — Contrato de importación de rendimiento alineado con qa-tests
2026-11-06 · base (RF-REN-01/05, ESP §7, §13.8)
- **Contexto:** qa-tests produce `samples.json` en snake_case (`schema_version` 1) con extensiones `provenance`
  (`dxmon|playwright`), `method`, `error_kind`, `censored_at_ms`, `timeout_limit_ms`, `content_encoding`,
  `null_reasons` y `metric_kind=root_current_wait` (docs/pendientes-integracion.md, qa-tests/tools/README-dxmon.md).
- **Decisión:** `parsePerfSamples` (validador autoritativo) acepta ese formato exacto; se añaden enums
  `PERF_PROVENANCES`, `PERF_ERROR_KINDS` y `root_current_wait`; `provenance` forma parte de la serie (agregados,
  `seriesSelector` de umbrales y `perf_hourly_aggregate`). El backend **recalcula** `endpoint_key`
  (`<METHOD> <ruta>[?typeOperation=…]`, segmentos con forma de ID → `:id`) y `over_29s`.
- **`over_29s`:** solo respuestas **completadas** con duración > 29 000 ms (RF-REN-05 "respuestas de más de 29 s"); un
  timeout es censurado y cuenta solo en timeouts, aunque su corte sea ≥ 29 s. CHECKs `ck_perf_sample_over_29s` y
  `ck_perf_sample_censored_timeout` en BD.

## D-017 — Estadísticas de rendimiento
2026-11-06 · base (ESP §13.8)
- **Decisión:** media/mín./máx. requieren ≥ 1 completada; p95 ≥ 20 completadas; tasas ≥ 20 iniciadas válidas; los
  pisos solo pueden aumentarse (`effectiveMinSamples`). Muestras con `invalid_reason` se descartan y se cuentan.
  Iniciadas sin duración disponible cuentan en tasas pero no en latencia (sin cero inventado). Pantallas
  (`screen_ready`, `root_ready`) clasifican error por condición (`ok=false`), no por HTTP. Agregados por intervalo
  conservan conteos/sumas/mín./máx.; p95 nunca se reconstruye desde agregados. Granularidad automática ≤ 1000 puntos.

## D-018 — Esquema PostgreSQL (Prisma)
2026-11-06 · base (ESP §7, §17.4)
- 51 modelos, ids UUID, `timestamptz(6)`, snake_case, 41 enums nativos. Restricciones no expresables en Prisma se
  escriben a mano al final de la migración (`KATALYST HAND-WRITTEN`): índices únicos parciales (lease vigente por shard,
  intento `corriendo` por resultado, corrida activa/en cola por programación, reservas de capacidad activas,
  `auth_subject`, nombre de ambiente activo) y CHECKs (correo en minúsculas, reintentos 0..2, pisos de `min_samples`,
  unidades, censura, etc.). `prisma migrate diff` contra la BD da migración vacía (sin deriva).
- `event_log.seq BIGSERIAL` es la PK (id SSE). `audit_log.actor_id` sin FK (el historial sobrevive a usuarios
  deshabilitados). `api_credential`: `principal_id` (usuario) XOR `service_name`; la credencial de dispositivo es un
  `api_credential` de tipo `dispositivo` enlazado 1:1 a `device`. Preferencias de notificación con tablas de unión.
  `perf_hourly_aggregate.worker_profile` NOT NULL default `''` para unicidad. `schedule_revision` único por
  `(schedule_id, revision)`: **toda** mutación (incl. pausa/reanudar/borrar) incrementa la revisión.
- Sección padre de la misma suite: FK compuesta `(parent_id, suite_id) → (id, suite_id)`.
- La migración inicial se regeneró una vez el 2026-11-06 (sin despliegues previos). Desde aquí, migraciones
  expand/contract; al usar `--create-only` revisar que Prisma no proponga `DROP` de los objetos escritos a mano.

## D-019 — Pool de conexiones y configuración por archivo
2026-11-06 · base (RNF-OPT-05)
- **Decisión:** defaults alineados con deploy: api 10 + control 6 + reports 3 = 19 ≤ `TOTAL_DB_POOL_BUDGET` (20).
  `DATABASE_POOL_MAX` (por servicio en docker-compose) sobrescribe el pool del proceso. `DATABASE_URL_FILE` y
  `REDIS_URL_FILE` se leen si la variable directa no está definida. El control actualiza el mtime de `HEALTH_FILE` en
  cada ciclo ≤ 15 s si está configurado.

## D-020 — Paginación y cursores
2026-11-06 · base (ESP §17.3)
- **Decisión:** `{ items, nextCursor, hasNext, total? }`, `limit` 1..100 (default 25), orden `campo`/`-campo` con
  claves permitidas por endpoint y desempate por UUID. Cursor opaco base64url de JSON (`encodeCursor`); la API puede
  firmarlo/HMAC si necesita impedir manipulación (no transporta datos sensibles).

## D-021 — Outbox: reintentos
2026-11-06 · base (ESP §13.4, RNF-CON-02)
- **Decisión:** backoff exponencial base 5 s ×2, jitter ±20 %, tope 1 h, vencimiento 24 h, `Retry-After` prevalece
  (acotado a 1 h). `outboxBackoffMs(attempt, random, retryAfterMs)`.

## D-022 — Revisión estática de código de test
2026-11-06 · base (ESP §10 regla 11, §13.6)
- **Decisión:** `lintTestSource` (sin ejecutar código) rechaza `.only`, `.skip` no autorizado, `TODO selector`,
  verificaciones pendientes, `waitForTimeout` (salvo rendimiento), XPath posicional, clases `css-xxxxx`, credenciales en
  `fill`, ausencia de `expect`, título sin `C<n>`, > 1 MiB y secretos (reportados sin reflejar el valor).

## D-023 — Seguridad del repositorio
2026-11-06 · base (RNF-SEG-01)
- **Decisión:** `.gitignore` excluye `.env*` (salvo `.env.example`), `storageState*`, `.auth/`, `*.tfstate*`, planes y
  crash logs de Terraform, `test-results`, `playwright-report`, `coverage`, `dist`. `.gitleaks.toml` extiende las reglas
  por defecto con canarios, `KATALYST_SECRET__*=valor`, API keys de TestRail, `storageState`, tokens Cognito y
  contraseñas literales; excepciones solo para fixtures sintéticos de `packages/shared/test/`.
- **Pendiente:** gitleaks no está instalado en el equipo local; la configuración no se ejecutó aún (`pnpm secrets:scan`).
- Cookie de sesión: default `katalyst_session`; en producción usar prefijo `__Host-` (contrato de deploy); lo aplica el
  módulo de auth.

## D-024 — Esqueleto de la API
2026-11-06 · base
- Fastify 5 + `fastify-type-provider-zod` (validación/serialización Zod, OpenAPI por `jsonSchemaTransform`),
  `x-request-id` aceptado si es seguro o UUID nuevo, eco en respuesta; CORS cerrado por defecto; helmet; rate limit
  (no aplica a 404 ni a `/healthz`/`/readyz`); error uniforme. Un plugin vacío por módulo en `src/modules/<módulo>/routes.ts`
  con README de responsabilidad y rutas (de `ROUTES`). `/readyz` comprueba `SELECT 1` y `PING` (1,5 s) y responde 503
  sin detalles internos. Entradas `main.api.ts`, `main.control.ts` (bucles vacíos), `main.reports.ts` (CSP estricta,
  sin cookies).

## D-025 — Rendimiento: estadísticas en SQL equivalentes a shared y retención
2026-11-06 · API-C (RF-REN-02, RF-REN-05, ESP §7, §13.8, §17.4)
- **Decisión:** `GET /perf` agrega en PostgreSQL por serie y bucket (`date_bin` UTC) con las mismas reglas que
  `computePerfStats` (prueba de equivalencia en `test/api-c-perf.test.ts`); p95 = `percentile_disc(0.95)` = valor en la
  posición `ceil(0,95·n)` base 1 sobre completadas válidas (incluye HTTP no exitoso). Dentro de la retención de crudos
  (desde el inicio del día UTC siguiente al corte de 90 días) se usan crudos; antes, `perf_hourly_aggregate` re-agrupado y
  p95 `no_disponible`. La granularidad efectiva (`chooseGranularity`, nunca `minute` fuera de retención) se devuelve en
  `granularity`; > 1.000 días → 422 `PERF_RANGE_TOO_LARGE`. Máx. 100 series por respuesta, ordenadas por clave.
- Filtro `screen`: en crudos filtra `screen_key` (peticiones y pantallas de esa pantalla); en agregados solo series de
  pantalla (`screen_ready|root_ready|root_current_wait <screen>`). `endpoint` acepta la clave de serie exacta o una ruta
  (se normaliza con `GET` por defecto).
- Comparación `previous_period`: puntos del período anterior con sus instantes reales (el panel los alinea por índice).
- Huecos: intervalos sin muestras > `PERF_GAP_THRESHOLD_MIN` (15 min = 3 ciclos de 5 min) y horas sin agregado.
- Rollup horario: UPSERT de las últimas 48 h completas; la purga primero completa (`DO NOTHING`) los agregados de las
  horas a borrar (incluida la del corte) y luego borra crudos > 90 días en lotes de 5.000; agregados > 365 días se borran.
  Importaciones tardías de horas ya agregadas con más de 48 h no se reflejan en el agregado (documentado).

## D-026 — Alertas: deduplicación por fila con bloqueo y entregas por outbox
2026-11-06 · API-C (RF-REN-03, RF-NOT-02, ESP §13.8)
- **Decisión:** una fila `alert` por huella `umbral:<id>:<ambiente>:<origen>:<canal>` (`alertFingerprint`). El evaluador
  hace `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` (mutex entre réplicas/reinicios) y envía solo si
  `canSendAlert(last_sent_at, now)` (ventana móvil de 60 min); `last_sent_at` se fija en la misma transacción que el
  `enqueueOutbox('notification.alert')` (dedupKey `alert:<id>:<instante>`, vigencia 1 h). Mientras siga superado se
  re-notifica como máximo una vez por hora. Normal → `recuperada` sin notificación; insuficiente → sin cambios.
- Sin canal activo la alerta se registra con `channel = null` (huella `…:sin_canal`) para el panel, sin envío.
- Entrega ambigua (timeout tras enviar a webhook/SMTP): se marca entregada con nota `entrega_ambigua` y
  `payload.deliveryAmbiguous = true`; no se reintenta (evita duplicados; los canales no tienen confirmación idempotente).
  Reintentable (429/5xx/conexión rechazada) → backoff del outbox; 4xx/autenticación → `requiere_intervencion`.

## D-027 — Notificaciones: canales del equipo, preferencias personales y corridas
2026-11-06 · API-C (RF-NOT-01, RF-NOT-03; canal pendiente ESP §12)
- **Decisión:** `notification_channel` por tipo; sin fila se usa el bootstrap de entorno (`NOTIFIER_CHANNELS`,
  `SLACK_WEBHOOK_REF`, `TEAMS_WEBHOOK_REF`, `SMTP_*`). Webhooks/credenciales SMTP solo por referencia (`env:` con prefijo
  `KATALYST_SECRET__`). Webhooks validados contra allowlist de hosts del proveedor (Slack `hooks.slack.com`; Teams
  `*.webhook.office.com`, `*.logic.azure.com`, `*.powerplatform.com`), solo https y sin redirecciones.
- Las preferencias personales (RF-NOT-03) definen destinatarios de CORREO (eventos + programaciones/umbrales o "todos");
  Slack/Teams son canales del equipo y reciben según el canal y `schedule.notify.channels` (vacío = todos los activos).
- Corridas: notifican `terminada/fallido` y `interrumpida` (respetando `notify.onFailure/onInterruption` de la
  programación). `enqueueRunFinishedNotification(tx, runId, config)` crea una alerta `corrida_*` por canal (huella
  `corrida:<runId>:<canal>`) y su entrega `notification.run_finished` (idempotente). El mensaje solo lleva resumen
  (conteos por estado, ambiente, origen, duración, commit corto) y enlace `/ejecuciones/<id>` (requiere sesión); nunca
  errores de tests, URLs crudas ni datos de clientes. Manuales: correo al creador si lo tiene en sus preferencias.

## D-028 — Flujo de dispositivo y grabaciones
2026-11-06 · API-C (RF-GRB-01/02/05/06, ESP §9 2C, §13.6)
- **Decisión:** device flow tipo RFC 8628: `deviceCode` `kdc_…` (solo hash), `userCode` `XXXX-XXXX` (alfabeto sin
  ambiguos), 5 min, intervalo 5 s; consulta antes del intervalo → 429 `DEVICE_SLOW_DOWN` (+5 s, máx 60). Aprobar/denegar
  exige cookie de sesión del panel (no tokens API). La credencial `kdv_…` (`api_credential` kind `dispositivo`, 90 días,
  `DEVICE_CREDENTIAL_TTL_DAYS`) se emite una sola vez (transición condicional `aprobada → consumida`). El asistente
  puede revocarse a sí mismo (`DELETE /devices/:id` con su credencial) aunque no tenga `devices.approve`.
- Enlace del asistente `katalyst://grabar?session=<id>` (pedido de coordinación de fase 2). **Diverge** del regex de
  `RecordingCreatedResponseSchema` en shared (`katalyst://recording/<id>`): la API usa un esquema local; pendiente que
  API-A alinee shared.
- Grabar exige ambiente habilitado, no producción **y** `recording_allowed`. `GET /recordings/:id` añade `environment`
  (id, nombre, appUrl, isProduction, recordingAllowed, enabled) para el asistente.
- Completar: el código no se persiste en el backend. Rechazan (sesión `rechazada`): secretos/credenciales (código,
  título, etiquetas o pasos; 422 `SECRET_DETECTED` sin valores), sintaxis inválida (parser de
  `module.stripTypeScriptTypes` de Node, sin ejecutar), sin `test(...)`, > 1 MiB (413). Advierten y bloquean aprobación
  (PR **borrador**): TODO selector, verificaciones pendientes, `.only/.skip`, `waitForTimeout`, CSS generado, XPath
  posicional, sin `expect`, pasos no soportados, varios tests, `storageState` eliminado.
- Archivo `tests/grabaciones/c<id>-<8 hex de la sesión>.spec.ts` (determinista), import de `../../fixtures/test.ts`,
  título `C<id> <texto> @tags` (sin `@escritura`), anotación `stableKey('<uuid>')` con UUID v4 derivado de la sesión
  (reintentos idempotentes). Manifiesto: entrada `sin_clasificar`, owner `qa-grabacion`; la clasificación sugerida por QA
  va en la descripción del PR. Rama `katalyst/grabacion/c<id>-<8hex>`; fallo de Git → la sesión vuelve a su estado previo.
- `GitPrProvider`: GitHub (Git Data API + Pulls), GitLab (Commits API con `start_branch` + MR `Draft:`), `local`
  (clon temporal + push a repo local, sin hooks). Nunca rama protegida ni merge; token por referencia en encabezados.

## D-029 — IA: proveedor, prompt versionado, presupuesto y salida
2026-11-06 · API-C (RF-GRB-03, RF-GRB-04, ESP §10, §13.7; proveedor pendiente ESP §12)
- **Decisión:** `AnthropicProvider` con el SDK oficial `@anthropic-ai/sdk` 1.6.0, modelo `AI_MODEL` (default
  `claude-opus-5-5`, precios de lista 4/20 USD por MTok verificados el 2026-11-06 y configurables), `output_config.effort`
  `AI_EFFORT` (default `medium`), sin herramientas, sin streaming, `maxRetries: 0` (un reintento oculto duplicaría costo),
  `stop_reason = refusal` → error. No se usan `fallbacks` del servidor: cambiarían el modelo/precio fuera de la reserva.
- Prompts `grb-03.v1` (base de ESP §10) y `grb-04.v1`: datos del caso/código serializados en `<datos_no_confiables>`,
  HTML eliminado, secretos redactados y delimitadores inyectados neutralizados; el sistema declara que el contenido son
  datos y que no hay herramientas.
- Presupuesto: tope de salida = min(`AI_MAX_OUTPUT_TOKENS`, lo que cabe en `AI_BUDGET_USD_PER_REQUEST` tras la entrada
  estimada); < 1.024 tokens → rechazo. Reserva del costo máximo en `generation_request` bajo `pg_advisory_xact_lock`
  contra los topes por usuario/día UTC y mensual; luego se reemplaza por el costo real. Rechazos quedan registrados
  (`rechazado_presupuesto`, motivo) y devuelven 429 `AI_BUDGET_EXCEEDED`.
- Salida: se descarta si contiene posibles secretos; se normaliza (import de fixtures, título, `stableKey`) y se publica
  como PR **borrador** en `katalyst/ia/c<id>-<8hex>` con manifiesto `sin_clasificar` (`tests/borradores/`). Construcciones
  no permitidas (`process.env`, `child_process`, red, `eval`) se listan para revisión humana; nunca se ejecuta.
- Revisión asistida: pasada determinista (quita `waitForTimeout` sin `// katalyst-espera-justificada`, reemplaza
  selectores `.css-xxxxx`/XPath posicional por `TODO selector`) + pasada IA opcional, descartada si elimina excepciones
  públicas MUI/Inovua, cambia `stableKey`, mantiene esperas fijas, contiene secretos o construcciones no permitidas.
  Se commitea en la rama del PR de la grabación. Sin IA configurada se registra con proveedor `determinista`, costo 0.

## D-030 — Exportaciones
2026-11-06 · API-C (RF-RES-04, ESP §17.3/§17.4)
- **Decisión:** alcances `runs | run_results | case_results | audit_log | perf` con el permiso del listado de origen
  (`runs.read`, `audit.read`, `perf.read`) además de `exports.create`; filtros validados con los esquemas compartidos del
  listado. `pagina` (cursor/limit ≤ 100) se genera en línea → 201 `listo`; `completo` → 202 `pendiente`, procesado fuera
  de la solicitud (y por el mantenimiento horario si el proceso se reinició). Límites: 50.000 filas CSV, 5.000 PDF
  (422 `EXPORT_TOO_LARGE`). CSV con BOM y `toCsv` (fórmulas neutralizadas); PDF con pdfkit 0.20.2 (A4 apaisado).
- Archivo privado `exports/<jobId>.<ext>` en el almacén de artefactos de API-B; vence a las `EXPORT_TTL_HOURS` (24 h);
  descarga por URL firmada ≤ 5 min tras autorización de dueño/admin; vencidos se eliminan y quedan `vencido`.

## D-031 — Variables de entorno de API-C pendientes de integrar en config.ts
2026-11-06 · API-C
- **Decisión:** mientras API-A no las incorpore a `src/config.ts`, se validan con Zod en
  `src/modules/recordings/settings.ts`: `GIT_PR_PROVIDER` (`github|gitlab|local|none`), `GIT_PR_LOCAL_REPO_PATH`,
  `RECORDING_TESTS_DIR`, `AI_DRAFTS_DIR`, `QA_TESTS_FIXTURE_IMPORT`, `RECORDER_INSTALL_URL`, `DEVICE_VERIFICATION_PATH`,
  `DEVICE_CREDENTIAL_TTL_DAYS`, `DEVICE_ONLINE_WINDOW_SECONDS`, `NOTIFIER_WEBHOOK_ALLOW_LOOPBACK`, `AI_EFFORT`,
  `AI_MAX_OUTPUT_TOKENS`, `AI_PRICE_INPUT_PER_MTOK`, `AI_PRICE_OUTPUT_PER_MTOK`, `EXPORT_TTL_HOURS`,
  `PERF_RAW_RETENTION_DAYS`, `PERF_AGGREGATE_RETENTION_DAYS`, `PERF_GAP_THRESHOLD_MIN`. Ninguna contiene secretos.
- Dependencias añadidas a `@katalyst/api` (bajo candado, versiones estables exactas verificadas el 2026-11-06):
  `nodemailer` 10.3.1 (incluye tipos), `@anthropic-ai/sdk` 1.6.0, `pdfkit` 0.20.2, `@types/pdfkit` 0.17.7 (dev).


## D-032 — Asistente local: stack, build y empaquetado Windows
2026-11-06 · RECORDER (RF-GRB-01, ESP §4, §9 2C)
- **Decisión:** `apps/recorder` con Electron **45.2.3** (último estable al 2026-11-06), electron-vite **6.0.0** sobre Vite
  **7.3.7**, React **19.3.1**, Tailwind **4.3.5**, lucide-react **1.70.0**, `@vitejs/plugin-react` **5.2.0** (mismas
  versiones que `apps/web`), electron-builder **26.18.0**, `@playwright/test` **1.65.0** exacta (única dependencia de
  runtime; el resto se empaqueta). main y preload se emiten en CommonJS (`.cjs`, requisito del preload con
  `sandbox: true`); `@katalyst/shared` y `zod` se empaquetan (condición `source`). `electron` añadido a
  `onlyBuiltDependencies` (descarga del binario).
- Instalador **NSIS x64 por usuario** (sin administrador, `HKCU` para `katalyst://`), sin firma en esta fase; asar con
  `asarUnpack` de `@playwright/test`, `playwright`, `playwright-core` (se ejecutan como CLI fuera del asar). Fusibles:
  `RunAsNode` **habilitado** (ver D-034), `EnableNodeOptionsEnvironmentVariable`/`EnableNodeCliInspectArguments`
  deshabilitados, `EnableEmbeddedAsarIntegrityValidation` y `OnlyLoadAppFromAsar` habilitados, cookies cifradas.
- Verificado en macOS: build, `electron-builder --dir` (contenido de asar/unpacked) y humo E2E con Electron real y
  codegen real (`e2e:smoke`). **No verificado**: instalador NSIS ni ejecución en Windows 11.

## D-033 — Credencial de dispositivo en el almacén del SO
2026-11-06 · RECORDER (ESP §13.6, RNF-SEG-01)
- **Decisión:** Electron `safeStorage` con las API asíncronas (`isAsyncEncryptionAvailable`/`encryptStringAsync`/
  `decryptStringAsync`; las síncronas están deprecadas en Electron 45): DPAPI del usuario en Windows, Keychain en
  macOS, libsecret/kwallet en Linux. El blob cifrado vive en `userData/device-credential.bin` (0600). Se descartó
  `keytar` (archivado, módulo nativo a recompilar por versión de Electron). Si el SO no ofrece cifrado real (Linux
  `basic_text`) la credencial NO se persiste (solo memoria) y la UI lo advierte.
- Revocación: «Desvincular» llama `DELETE /devices/:id` (best-effort) y borra el archivo; un 401 de cualquier llamada o
  del heartbeat borra la credencial local. La credencial se asocia al origen del servidor (cambiar servidor la borra).
  Desinstalar borra `userData`.

## D-034 — codegen como proceso hijo con ELECTRON_RUN_AS_NODE
2026-11-06 · RECORDER (RF-GRB-01, RF-GRB-06)
- **Contexto:** codegen solo es API pública como CLI (`playwright codegen --target=playwright-test --output …
  --load-storage …`); la vía programática (`browserContext._showRecorder`) es privada.
- **Decisión:** ejecutar `@playwright/test/cli.js codegen` con el ejecutable de Electron y `ELECTRON_RUN_AS_NODE=1`
  (no se distribuye otro Node), `shell: false`, entorno en **lista blanca** (sin `NODE_OPTIONS`, sin `KATALYST_*`,
  sin tokens), argumentos sin secretos (solo la RUTA del storageState). La salida se lee por sondeo del archivo
  (codegen la reescribe cada ~250 ms). Detener: SIGTERM con escalado a SIGKILL; en Windows `taskkill /T /F`.
  Consecuencia: el fusible `RunAsNode` queda habilitado (riesgo aceptado: equivale a ejecutar Node como el usuario).
- «Agregar verificación» no puede accionar la barra de codegen desde fuera: el asistente registra el pedido como
  verificación pendiente y guía a *Assert visibility/text/value*; se cumple cuando aparece un `expect` nuevo.
- Login **sin captura**: Chromium propio de Playwright (`chromium.launch({headless:false})`), el QA inicia sesión (MFA
  local) y el asistente escribe `context.storageState()` en el directorio temporal; luego cierra ese navegador y abre
  codegen con `--load-storage`. «Grabar sin iniciar sesión» lanza codegen sin estado.

## D-035 — Distribución de Chromium del asistente
2026-11-06 · RECORDER (RF-GRB-01)
- **Decisión:** dos vías, ambas con la revisión de Chromium de Playwright 1.65.0: (a) incluido en el instalador
  (`pnpm --filter @katalyst/recorder browsers:fetch` en la máquina Windows de build → `build/ms-playwright` →
  `resources/ms-playwright`); (b) si no está incluido, botón «Instalar Chromium» que ejecuta
  `playwright install chromium --no-shell` hacia `userData/ms-playwright` (HTTPS saliente al CDN de Playwright).
  Se usa un Chromium dedicado, nunca el perfil ni el navegador personal del QA (ESP §13.7).

## D-036 — Almacenamiento local de la grabación y limpieza
2026-11-06 · RECORDER (ESP §7, §13.6, §13.7)
- **Decisión:** `<temp del usuario>/katalyst-recorder/<uuid>/` con `0700` (POSIX) e `icacls /inheritance:r` al usuario
  actual en Windows (best-effort); `state.json` (storageState, `0600`), `recording.spec.ts` (salida de codegen) y
  `meta.json` sin secretos. El storageState se sobrescribe con ceros y se elimina al cerrar la grabación, al descartar,
  al enviar, al salir del asistente, al iniciar (sesiones abandonadas) y a las 2 h (o al vencer la grabación). El código
  sin enviar se conserva hasta 24 h para reanudar el envío y se borra tras enviar/cancelar. Limpieza periódica 5 min.
  En SSD la sobrescritura no garantiza borrado físico (limitación documentada).
- Heartbeat `POST /devices/heartbeat` cada 60 s (la API considera en línea ≤ 120 s, `DEVICE_ONLINE_WINDOW_SECONDS`).

## D-037 — Validación local, pasos y bloqueo de producción en el asistente
2026-11-06 · RECORDER (RF-GRB-05, RF-GRB-06, ESP §10, §13.6)
- **Decisión:** antes de enviar: errores bloqueantes = > 1 MiB, secretos/datos personales (`verifySanitized` por línea,
  sin valores), `waitForTimeout`, `.only/.skip`, credenciales escritas, sin test; advertencias que exigen confirmación
  explícita = `TODO selector`, verificaciones pendientes (sin `expect`, acciones después de la última verificación o
  verificación pedida sin cumplir), interacciones no soportadas (mouse por coordenadas, subida de archivos, diálogos
  nativos, descargas, instrucciones no reconocidas), selectores frágiles y valores enmascarados. Opción «Reemplazar
  datos sensibles por marcadores» (`sanitizeText` + parámetros sensibles de URL). El backend revalida (D-028).
- Título `C<id> <texto> @tags` y `page.goto` relativos al origen del ambiente (baseURL por project en qa-tests).
- Producción: bloqueo si `isProduction`, `recordingAllowed=false`, ambiente deshabilitado o desconocido (falla
  cerrado), URL no https (http solo loopback en desarrollo) o host productivo conocido (`cbc.deltax.la`,
  `fmsapi.deltax.la`, subdominios). Se usa la extensión `environment` de `GET /recordings/:id`; `GET /environments`
  solo como respaldo (el principal de dispositivo no tiene `environments.list`).
- Enlaces aceptados: `katalyst://grabar?session=<uuid>` y `katalyst://recording/<uuid>` (forma de shared); cualquier
  otro parámetro invalida el enlace completo.

## D-038 — Planificación de corridas (API-B)
2026-11-06 · API-B (RF-EJE-01/06/07, ESP §13.1, §13.4)
- **Revisión del catálogo:** se usa la última `catalog_revision` `completa` con `git_commit` y `manifest_hash`; sin ella ⇒
  422 `CATALOG_REVISION_INCOMPLETE`. Si la revisión guarda el manifiesto, se valida y su hash debe coincidir
  (`MANIFEST_INVALID`); es la fuente de clasificación para detectar contradicciones (BD≠manifiesto, `@escritura` en un test
  no `escritura`, retirado en manifiesto y aprobado en BD).
- **Expansión:** casos explícitos o por sección (con descendientes) ejecutan su conjunto requerido completo (tests
  `aprobado` vinculados × `parameterKeys`); etiquetas (OR, `@escritura` derivada) agregan sus tests y los casos tocados,
  posiblemente con cobertura parcial. Caso sin tests aprobados ⇒ `sin_automatizacion` (`test_no_aprobado`/`test_retirado`
  si los hay). Suites dinámicas omiten casos archivados con advertencia; selección explícita de archivados ⇒ 422.
- **Producción:** bloquea `escritura_en_produccion`, `clasificacion_ausente`, `clasificacion_contradictoria`,
  `revision_pendiente` y, sin usuario de prueba `read_only`, `usuario_con_escritura` (bloqueador global). Programadas
  bloquean `revision_pendiente` en cualquier ambiente; staging manual solo advierte. Excluir flaky ⇒ resultado `omitido`.
- **Usuario reservado:** primer usuario habilitado por etiqueta (en producción el primero de solo lectura); solo referencia.
- **`previewToken`** = SHA-256 del plan resuelto (ambiente+versión, usuario, revisión, commit, tests/casos y bloqueos):
  distinto al crear ⇒ 409 `ADMISSION_CONFIG_CHANGED`. Tipo `rendimiento` si todos los ejecutables llevan `@rendimiento`.
- **Destinos TestRail:** uno por suite de los casos del plan, solo con conexión habilitada y `testrail.mode ≠ ninguno`;
  `existente` exige una sola suite.

## D-039 — Idempotencia de corridas y de callbacks del worker
2026-11-06 · API-B (ESP §9, §13.3; RF-EJE-08)
- `POST /runs`: `actor_key` = `<kind>:<id>` del principal; hash = SHA-256 del cuerpo canónico (con defaults). La clave,
  la corrida y todas sus filas se crean en UNA transacción (la clave nunca queda `en_proceso` visible); carrera ⇒ P2002 ⇒
  se relee y devuelve la misma corrida (200). Vencida (> 24 h) se elimina y se reutiliza. Tokens API registran también el
  usuario dueño en `run.created_by`.
- Callbacks: `(runResultId, attemptNo)` + `start_request_hash`/`result_request_hash`. El acuse original de
  `/worker/results` se persiste en `idempotency_key` (`actor_key = worker-result:<runResultId>`, 24 h) y se devuelve con
  `duplicate: true` aunque el lease haya terminado; contenido distinto ⇒ 409 `CALLBACK_CONFLICT`.
- `final` lo decide el servidor: final si el worker lo indica, si pasó, o si la política no admite otro retry.

## D-040 — Capacidad, shards y despacho BullMQ
2026-11-06 · API-B (RF-EJE-04, RNF-OPT-05, ESP §13.3/§13.5)
- Shards: `min(environment.max_concurrency, min(GLOBAL_BROWSER_CONCURRENCY, runtime.capacity.globalBrowserConcurrency))`
  (1 por defecto; rendimiento siempre 1), reparto round-robin estable; `assigned_test_keys` = `{runResultId, stableKey,
  parameterKey}`.
- Reserva por shard y alcance (`global`, `environment`, `test_user` con 1 si no admite concurrencia) con
  `INSERT … SELECT generate_series … ON CONFLICT (scope, scope_key, slot) WHERE released_at IS NULL DO NOTHING`; sin slot
  se eliminan las reservas parciales del shard y la transacción sigue íntegra. Vigencia inicial 5 min (ventana de claim),
  extendida por claim/heartbeat; el watchdog libera huérfanas.
- Admisión FIFO por `queued_at` con `FOR UPDATE SKIP LOCKED` (API y control pueden admitir). Cada admisión crea una
  entrega `run.dispatch_shard` (dedup aleatorio por admisión) en la misma transacción. Se procesa por el handler del
  publicador genérico y por un camino rápido propio (1 s); ambos publican en la cola BullMQ `run-shards` (prefijo
  `QUEUE_PREFIX`, job `shard`, datos `{runId, shardId}`, `jobId = shard-<shardId>-<deliveryId>`).
- Reconciliación: shard `asignado` sin lease > 60 s ⇒ nueva entrega; > 5 min ⇒ libera reserva y vuelve a admisión.
  `claim` solo desde `asignado`, sin lease vigente: entregas duplicadas ⇒ 409 `SHARD_NOT_CLAIMABLE`.
- Estados: `en_cola` hasta el primer claim (`preparando`, `started_at`), `corriendo` al primer intento. Retraso de
  admisión = reserva − (instante previsto | encolado); retraso de inicio = claim − reserva (histogramas separados).

## D-041 — Leases, recuperación y orden de bloqueo
2026-11-06 · API-B (RNF-CON-01, ESP §13.3)
- Orden global de bloqueo: corrida `FOR NO KEY UPDATE` (compatible con las FK de filas hijas) y luego shard
  `FOR UPDATE`; lo siguen claim, callbacks, watchdog y cancelación (evita interbloqueos).
- Recuperación UNA vez por corrida (suma de `run_shard.recovery_count`): lectura en curso ⇒ intento
  `error_infraestructura/worker_perdido` y se reasigna como `recuperacion`; escritura/sin clasificar en curso ⇒
  `error_infraestructura` + `escritura_resultado_desconocido` (no se reasigna); pendientes se conservan. Agotada ⇒ shard
  `interrumpido` y corrida `interrumpida/recuperacion_agotada`. Callbacks a corridas terminales ⇒ 409 `RUN_FINALIZED`.
- `finalize` de artefactos admite lease liberado (no revocado) mientras la corrida está en `finalizando`.

## D-042 — Cancelación y contrato de control con el supervisor
2026-11-06 · API-B (RF-EJE-03)
- Canal Redis pub/sub `<QUEUE_PREFIX>:runs:control`; mensaje JSON `{type: 'cancel'|'revoke', runId, shardIds[], leaseIds[],
  reason, requestedAt, deadlineAt}`. `cancel`: detener el árbol de procesos antes de `deadlineAt` (≤ 30 s) y llamar
  `POST /worker/complete {shardStatus:'cancelado'}`; `revoke`: el lease ya no es válido (vencido, cancelación sin
  confirmar o timeout de corrida): matar el contenedor y limpiar. Redis es transporte: el heartbeat devuelve
  `cancelRequested/cancelDeadlineAt` y `POST /worker/attempts` responde `proceed=false` (intento `cancelado`).
- Shards no reclamados se cancelan al instante y sus entregas de despacho pasan a `cancelada`; sin leases vivos la
  corrida queda `cancelada` en la misma solicitud (`stopConfirmed: true`). A los 30 s sin confirmación: revocar leases,
  cerrar `cancelada` y auditar `run.cancel_unconfirmed`.
- Timeout de corrida congelado (20 min funcional / 4 min rendimiento) ⇒ `interrumpida/timeout_corrida` + señal `cancel`.

## D-043 — Finalización y delegación de publicación/notificación
2026-11-06 · API-B (ESP §13.2, §13.4; RF-TR-04, RF-NOT-01)
- Con todos los shards terminados: cancelación pedida ⇒ `cancelada`; algún shard `interrumpido` ⇒ `interrumpida`; si hay
  artefactos `pendiente` ⇒ `finalizando` hasta que se manifiesten o venzan `min(60 s, finalizingMs)`; los no manifestados
  pasan a `fallido` y la corrida a `evidence_incomplete` sin cambiar el resultado.
- En la MISMA transacción: `aggregateCase` por caso del snapshot (motivo de plan si el caso no es ejecutable),
  `computeRunOutcome`, cierre de trabajo abierto, liberación de leases/capacidad, y luego
  `enqueueTestRailPublication(tx, runId)` (API-A, orden crear → resultados → adjuntos → cerrar) y
  `enqueueRunFinishedNotification(tx, runId, config)` (API-C). Una corrida `omitida` no tiene casos publicables ⇒ sin
  destino externo.

## D-044 — Programaciones: cursor, gracia y disparadores
2026-11-06 · API-B (RF-PRG-01..05, ESP §13.5)
- Cursor `reconciliation_cursor.reconciled_until` inclusivo del último instante procesado; cada tick procesa
  `(cursor, now]` con `occurrencesBetween` (≤ 200 instantes/tick/programación). Instante con más de 60 s de atraso al
  procesarse ⇒ `omitida/caida_servicio` (sin ráfaga); ventana de exclusión ⇒ `omitida/ventana_exclusion`; plan inválido ⇒
  `seleccion_vacia`/`ambiente_deshabilitado`/`configuracion_invalida`.
- Ocurrencia + corrida + reserva + despacho en una transacción; el índice `ux_run_active_per_schedule` resuelve carreras
  entre réplicas (⇒ `solapamiento`).
- Pausadas no materializan; crear/editar/reanudar ponen el cursor en "ahora" (sin catch-up). La copia de `duplicate`
  nace pausada. Autor de revisiones = usuario de la sesión, del dispositivo o dueño del token API.
- BullMQ Job Schedulers (`schedule-triggers`, id `schedule-<id>-<índice>`, `pattern` + `tz`) solo despiertan la
  materialización de esa programación; la API los sincroniza best effort y el reconciliador desde PostgreSQL. Su
  semántica DST no se usa para decidir instantes.

## D-045 — Almacén de artefactos y visor de reportes
2026-11-06 · API-B (RF-RES-02, RNF-SEG-05, ESP §13.7, §18)
- Claves `runs/<runId>/<artifactId>.<ext>` generadas por el servidor; tipos por clase (`captura` png/jpeg, `traza` zip,
  `video` webm/mp4, `reporte` html/json, `log` texto/json, `dxmon_*` json), ≤ 200 MiB por objeto, cuota por corrida de
  la política (250 MiB por defecto). S3: URL PUT SigV4 que firma `content-type`, `content-length` y
  `x-amz-checksum-sha256` (S3 rechaza contenido distinto); `stat` con `ChecksumMode`. El adaptador S3 se carga con import
  dinámico (solo `s3|minio`).
- `fs` (solo desarrollo): URLs firmadas HMAC (método, clave, vencimiento ≤ 300 s, tipo, tamaño, checksum) atendidas por
  el visor en `/_store/*`; clave derivada de `SESSION_SECRET_REF` o, sin ella fuera de producción, de la configuración
  local (API y visor coinciden). En producción `fs` exige `SESSION_SECRET_REF`.
- Visor: ticket `krt_…` de un solo uso (Redis `GETDEL`, 300 s) emitido por `GET /runs/{id}/artifacts/{artifactId}`;
  reporte HTML con CSP `sandbox allow-scripts` (origen opaco), `script-src 'unsafe-inline'` (reporte autocontenido de
  Playwright), `connect-src 'none'`, `form-action 'none'`; trazas se entregan como descarga (`attachment`). El origen del
  visor nunca emite cookies.
- `finalize` sin objeto ⇒ 409 sin cambiar estado; tamaño/checksum distinto ⇒ objeto borrado y `fallido`.

## D-046 — SSE
2026-11-06 · API-B (RF-EJE-02, RNF-OPT-04, ESP §17.2)
- Hub por proceso: sondeo de `event_log` (1 s, solo con clientes) despertado por `<QUEUE_PREFIX>:events`. Al conectar:
  `retry: 3000`, `snapshot {lastSeq, activeRunIds, serverTime}` (+ `run` en `/runs/{id}/events`), reposición desde
  `Last-Event-ID` o `reset` si el id es anterior a la retención (24 h), luego eventos en vivo; `ping` cada 25 s.
- Autorización por evento según tema/permiso; temas de propietario (`recording_session`, `export_job`,
  `generation_request`) solo al dueño (`data.ownerId` o `data.createdById`) o admin. Máx. 10 canales por principal (429).

## D-047 — Orquestación del proceso de control
2026-11-06 · API-B
- Bucles: `planificador` (≤ 15 s: ocurrencias, omisión por gracia, admisión, finalización), `despacho_shards` (1 s),
  `watchdog_leases` (≤ 15 s), `reconciliador` (`RECONCILER_INTERVAL_MS`), `limpieza_diaria` (cada hora, ejecuta una vez
  en `CLEANUP_HOUR_UTC`), `health_file` (si `HEALTH_FILE`; además lo tocan planificador y watchdog), y de otras áreas por
  import dinámico tolerante y memoizado: `publicador_outbox` (`runOutboxPublisherTick`), `sync_testrail`
  (`runScheduledTestRailSync`), `evaluador_umbrales` (`evaluatePerfThresholds`, 60 s) y `rollup_rendimiento`
  (`runPerfRollup`, 1 h). Al arrancar: `registerTestRailControl`, `registerNotificationHandlers`,
  `registerOutboxMetrics`, `registerDispatchHandler`. Si un módulo falta o falla, se registra y el resto sigue.
  Se usan las funciones de un tick (no los bucles con `AbortSignal`) para un único mecanismo sin solapamiento.

## D-048 — Limpieza diaria
2026-11-06 · API-B (ESP §7)
- Idempotente y por lotes: `idempotency_key` vencidas; `event_log` > 24 h; artefactos vencidos de corridas terminales
  (se borra el objeto y se conserva la fila con `storage_key = NULL` y motivo); entregas terminales, auditoría y
  ocurrencias > 365 días; corridas terminales > 365 días sin muestras de rendimiento, alertas, objetos vigentes ni
  ocurrencia (sus hijos se borran en orden por FK `Restrict`). Nunca toca corridas activas.

## D-049 — Cierre de API-B: métricas en la API, listado de catálogo y contrato final con el supervisor
2026-11-06 · API-B (RNF-OBS-01/02, RF-CAT-01, RNF-CON-01, RNF-MAN-01)
- El colector `runs` (`registerRunMetrics`, idempotente por nombre) se registra en la API (plugin `runs`) además del
  control: el host solo lee el `/metrics` de la API (`deploy/scripts/publish-metrics.sh`), que así expone
  `katalyst_queue_oldest_waiting_seconds`, `katalyst_queue_pending` y `katalyst_worker_leases_expired_recent` calculados
  desde PostgreSQL en el scrape (no dependen de qué proceso admitió). `katalyst_bullmq_jobs{state}` sigue solo en control.
- `POST /worker/catalog/listing` importa estáticamente `applyCatalogListing` de API-A (ya existe) en lugar del import
  dinámico tolerante; `bodyLimit` de la ruta = `MAX_LISTING_BYTES + 256 KiB` para que el recorte a 8 MiB lo decida el
  catálogo (revisión fallida) y no el límite global de Fastify.
- Contrato con el supervisor congelado y documentado en `docs/pendientes-integracion.md` («Contrato FINAL con el
  supervisor»): cola `run-shards` (job `shard`, `{runId, shardId}`, `attempts: 1`, re-despacho por la API), canal
  `<QUEUE_PREFIX>:runs:control` (`cancel`/`revoke`), cola `catalog-listing` (API-A, `jobId = catalogRevisionId`).
- Cobertura medida (RNF-MAN-01) solo con pruebas de integración contra PostgreSQL/Redis reales: `scheduler.ts`
  96,0 %/79,7 %, `results.ts` 90,4 %/73,2 % (líneas/ramas).

## D-050 — Cierre de API-A: listado del catálogo, flaky persistido, búsqueda medida y contratos añadidos
2026-11-06 · API-A
- **Listado aislado (RF-CAT-01, ESP §4):** `POST /tests/refresh` resuelve en servidor el SHA de la rama protegida
  (`GitRepoReader`: `local`, GitHub, GitLab; sin refs del cliente, cuerpo estricto) y encola `catalog-listing`
  `{catalogRevisionId, gitCommit}` (`jobId` = revisión) para el supervisor; la API nunca ejecuta ni importa código de
  tests. `src/modules/catalog/listing.ts` → `applyCatalogListing(prisma, body, principal)`: solo principal `service`
  (scope `worker.claim`), revalida con `WorkerCatalogListingRequestSchema`, `MAX_LISTING_BYTES` = 16 MiB (excedente ⇒
  revisión `fallida` con `LISTADO_FALLIDO`; 5.000 tests ≈ 5–7 MiB de `playwright --list`). Ingesta con
  `validateManifest` en modo catálogo: inválida ⇒ revisión `fallida` sin tocar el catálogo; válida ⇒ una transacción
  con identidad por `stableKey`, vínculos N:M ajustados, salidos del manifiesto `retirado`; repetición = acuse idempotente;
  commit distinto ⇒ 409; revisión `en_curso` > 30 min se da por abandonada al pedir otra.
- **Flaky persistido (RF-CAT-04, §13.1):** `automated_test.flaky_*` se recalcula en la ingesta, con
  `recomputeFlakyForRun(tx, runId)` (para la finalización de API-B) y como red de seguridad en el tick horario
  `sync_testrail` (`recomputeRecentFlakyScores`, corridas finalizadas en 2 intervalos; un fallo solo se registra).
- **Búsqueda medida (RF-CAT-02, §17.4):** `ILIKE '%q%'` sobre títulos con índices GIN `pg_trgm`
  (migración `catalog_title_trgm`). Medición local (PostgreSQL 16, 50.000 títulos sintéticos, `LIMIT 26` ordenado):
  sin índice seq scan 28–31 ms; con GIN 12,8 ms (término amplio, 10.000 coincidencias) y 0,12 ms (selectivo).
  `C123`/`123` busca por ID externo.
- **config.ts:** incorpora las 18 variables de API-C (D-031) con los mismos defaults (prueba de paridad con
  `ApiCEnvSchema`) y `ARTIFACT_FS_SIGNING_KEY_REF` (pedido de API-B, D-045); todas en `.env.example`.
- **shared (solo añadidos):** `RecordingAssistantLinkSchema` (`katalyst://grabar?session=<id>`),
  `RecordingEnvironmentSummarySchema`, `RecordingDetailSchema`, `RecordingCreatedSchema`, `GenerationDetailSchema`,
  `PerfSeriesItemSchema`. `RecordingCreatedResponseSchema` (forma antigua) se conserva por compatibilidad.
- **Cobertura (RNF-MAN-01, `vitest --coverage`, integración real PostgreSQL/Redis):** servicios TestRail
  `modules/testrail` 95,1 % líneas / 77,8 % ramas (`sync.ts` 100/82,7, `publication.ts` 86,1/77,3, `cases.ts`
  100/87,5), `adapters/testrail` 96,2/88,8, `control/outbox-publisher.ts` 100/87,7, `control/testrail-sync.ts` 96/75;
  `modules/catalog` 97,7/80,8. Suite completa de la API: 23 archivos, 232 pruebas en verde.

## D-051 — Cierre de RUNNER: contrato final verificado, compuerta de intento, e2e e integración con la API real
2026-11-06 · RUNNER
- **Contrato D-049 verificado en `apps/runner`:** cola `run-shards` (job `shard`, payload validado con
  `ShardJobPayloadSchema`), claim sin reintento HTTP; 409 (`SHARD_NOT_CLAIMABLE`), 404 y 422 (`PRODUCTION_BLOCKED`) ⇒
  el trabajo se confirma sin ejecutar (`not_claimable`). Canal `<QUEUE_PREFIX>:runs:control`: `cancel` y `revoke` con
  filtro por `shardIds`/`leaseIds`; se parsean además `reason` y `deadlineAt`.
- **Correcciones de divergencias:** (1) `deadlineAt` del mensaje `cancel` y `cancelDeadlineAt` del heartbeat acotan la
  gracia SIGTERM→SIGKILL a `deadlineAt − ahora − 4 s` (mín. 0,5 s, máx. `KATALYST_CANCEL_GRACE_MS`) para que el árbol
  esté detenido y el `complete cancelado` enviado antes del límite; (2) 409 `RUN_FINALIZED` se trata como lease
  perdido (detenerse sin reintentar), igual que `LEASE_STALE|LEASE_EXPIRED`; `CALLBACK_CONFLICT` sigue sin reintento
  pero no detiene el shard; (3) `catalog-listing`: límite de 16 MiB sobre manifiesto + listado serializados
  (`MAX_LISTING_BYTES` de la API, D-050); si se excede se envía `error: 'listado_demasiado_grande'` sin el listado.
- **Compuerta de intento (ESP §13.3, "persistir inicio antes de interactuar"):** el reporter avisa del inicio por IPC,
  el ejecutor llama `POST /worker/attempts` y escribe `<KATALYST_ATTEMPT_GATE_DIR>/<testId>-<retry>.json`
  `{proceed}`; la fixture `test` del proyecto espera ese archivo (≤ 30 s) y hace `test.skip` si `proceed=false`.
  Protocolo propuesto a qa-tests (implementado en `apps/runner/test/fixtures/pw-project/fixtures/test.ts`).
- **Proyecto de Playwright:** la asignación aún no trae `environment.name`; sin él el ejecutor usa
  `KATALYST_ENV_NAME=katalyst` y `--project=katalyst` (campo opcional hacia adelante en `RunnerShardAssignmentSchema`).
- **Pruebas reales:** e2e `test/e2e/process-e2e.test.ts` (launcher `process`, Chromium real, página HTML local, API
  falsa por HTTP) e integración `test/integration/api-real.test.ts` (apps/api en proceso con PostgreSQL
  `katalyst_test_runner` y Redis índice 4: POST /runs → outbox → BullMQ → supervisor → ejecutor → `terminada/fallido`;
  cancelación por pub/sub < 30 s ⇒ `cancelada`). Los módulos de la API se importan dinámicamente para no acoplar el
  typecheck del runner al de la API; la prueba se omite con motivo si PostgreSQL/Redis no están disponibles.

## D-052 — Cierre de WEB: contratos reales en MSW, rutas derivadas y presupuesto de bundle
- **MSW = contrato:** `apps/web/src/mocks/contract.ts` pasa cada respuesta del mock por el schema de
  `@katalyst/shared` con el que serializa la API (campos extra se descartan; violación ⇒ 500 `MOCK_CONTRACT_VIOLATION`)
  y valida cuerpos con los schemas de creación/edición (422 `details.issues`). Códigos de estado, paginación (sin
  `total`) y errores iguales a `apps/api/src/modules/*/routes.ts`.
- **Sin endpoints inventados:** se eliminaron `/dashboard/summary`, `/catalog/tags`, `/tests/:id/source`,
  `/perf/summary`, `/notifications/rules` y `/recordings/:id/commands`. El inicio deriva KPIs de `/runs`, `/schedules`,
  `/testrail/sections` y `/environments` (conteos sobre una página de 100, "100+" si `hasNext`); el resumen de
  rendimiento sale de `GET /perf`; "Avisar cuando" edita las preferencias propias (RF-NOT-03); detener/verificar/PR de
  una grabación se hace en el asistente (`katalyst://grabar?session=<id>`). Lo que falta en la API quedó en
  `docs/pendientes-integracion.md` como `[WEB→API-*]`.
- **Aprobación de dispositivo** en `/dispositivos/vincular?codigo=XXXX-XXXX` (mismo origen, `DEVICE_VERIFICATION_PATH`).
- **Presupuesto RNF-OPT-03:** `pnpm --filter @katalyst/web size` construye y falla si el JS inicial (script de
  entrada + modulepreload + imports estáticos) supera 250 KiB gzip. Recharts ya no va a un `manualChunk` (Rollup
  arrastraba dependencias compartidas y lo volvía inicial); queda diferido por `import()`. Medido: 203 KiB inicial.

## D-053 — Integración y aceptación local: correcciones detectadas en los ensayos
2026-11-06 · INTEGRACIÓN
- **Verificador de sanitización (`packages/shared/src/sanitize/verify.ts`):** un parámetro de query sensible cuyo
  valor ya está enmascarado y va seguido solo de puntuación de código (`?token=[REDACTED:x]}` al sanitizar
  ``?token=${expr}`` en el código fuente que Playwright incrusta en `error-context.md` y en el reporte HTML) ya no
  cuenta como hallazgo residual. Antes bloqueaba (fail-closed) el log de la falla y el reporte HTML completo sin que
  contuvieran secretos. Un valor real tras el marcador (`[REDACTED]abc`, `[REDACTED]}secreto`) sigue bloqueando.
  Prueba: `packages/shared/test/sanitize.test.ts` («D-053…»).
- **Trazas sin píxeles (`apps/runner/src/executor/artifacts/sanitize-artifact.ts`):** al sanitizar un ZIP se
  eliminan las entradas `screencast/*.(jpe?g|png|webp)` (fotogramas de página completa de las trazas de
  Playwright), que el ensayo de canarios mostró con datos sensibles visibles y que no pueden sanitizarse. El resto
  de la traza (red, DOM, pasos, fuentes) se sanitiza como antes. Prueba: `apps/runner/test/acceptance/trace-pixels.test.ts`.
  Las capturas (`captura`) NO se modifican: siguen deshabilitadas por defecto y solo deben habilitarse con datos
  sintéticos hasta implementar enmascaramiento visual (docs/aceptacion/seguridad.md §2.1).
- **N+1 en `GET /schedules` (`apps/api/src/services/scheduler.ts`, `modules/schedules/routes.ts`):** la última
  ocurrencia de cada programación se consultaba por fila (101 consultas con `limit=100`). Ahora
  `lastOccurrencesFor()` la obtiene en una sola consulta `DISTINCT ON (schedule_id)` sobre el índice único
  `(schedule_id, scheduled_for)`; `toScheduleDto` acepta el valor precargado (los endpoints de un elemento siguen
  consultando). Medido con `scripts/load/explain-queries.ts`: 3 consultas con `limit=10` y con `limit=100`.
  Prueba: `apps/api/test/acceptance/schedules-list-batch.test.ts`.
- **gitleaks:** `[allowlist]` convertido a `[[allowlists]]` y excepciones acotadas por regla para fixtures
  sintéticos de pruebas, `stableKey` UUID y el mock MSW del panel (docs/aceptacion/seguridad.md §1).
- **Stack local y ensayos** (`scripts/`): `dev-stack.sh`, `fake-testrail.mjs`, `fake-deltax.mjs`, `seed-dev.ts`,
  `e2e-local.ts`, `aceptacion-canarios.ts`, `load/*`, `backup-restore-local.sh`; resultados en `docs/aceptacion/`.

## D-054 — Pendientes WEB→API resueltos, SSE 401/403, RF-TR-06 en el panel y lint limpio
2026-11-06 · INTEGRACIÓN
- **WEB→API-A (solo se añaden campos/filtros opcionales, nada se rompe):** `TestRailCaseSummary` incluye `tags` (unión),
  `classification` (la más restrictiva: escritura > sin_clasificar > lectura) y `flaky` (el peor `FlakyInfo`) de los
  tests vinculados NO retirados, calculados en `enrichCases` con la misma consulta de vínculos (sin consultas extra);
  `GET /testrail/cases?ids=` (UUID repetible, ≤ 100, combinable con los demás filtros); `lastResult=sin_ejecutar` (casos
  sin ningún `case_result`; `pendiente`/`no_ejecutado` siguen filtrándose por su propio valor). `EnvironmentSummary.appUrl`
  (qa): ya es visible para qa en el snapshot de la corrida (`runs.read`), así que no amplía la exposición; `apiUrl`,
  política de artefactos y hosts siguen siendo solo admin. El panel dejó de consultar `/tests?caseId=` por fila y
  resuelve selecciones con una sola consulta `ids`.
- **WEB→API-B:** `GET /runs/summary` (módulo runs, `runs.read`, en `ROUTES`): `groupBy` de `outcome` para éxito 7 días vs.
  los 7 anteriores (corridas `terminada` con resultado, creadas en la ventana), `runsToday` desde `todayFrom` (inicio de
  día local que envía el cliente; por defecto 00:00 UTC), `running` (estados activos) y las 3 próximas programaciones
  habilitadas con su ambiente (solo con `schedules.read`). `RunSummary.selectionLabel` se arma del snapshot ("N casos",
  "Etiquetas @a, @b", "Suite X"). La clave de caché del inicio cuelga de `dashboard`, que el SSE ya invalida.
- **WEB→API-C:** `GET /perf` añade `series[].summary` con p95 del PERÍODO sobre muestras crudas (`percentile_disc(0.95)`,
  mismo mínimo de 20 completadas), `completed` y promedios de `bytes_wire`/`bytes_body`; si el período empieza antes de la
  retención de crudos, `p95Status: no_disponible` y bytes `null` (los agregados horarios no los conservan). El panel
  quita «peor p95 por intervalo» y agrega las columnas «En red» y «Descomprimido».
- **Abiertos (documentados como `[WEB→API-A2]` y `[WEB→API-C2]`):** `GET /tests/:id/source` (la API no persiste código
  fuente; requiere decidir ingesta sanitizada vs. lectura bajo demanda) y reglas globales de notificación (decisión de
  producto: nuevo modelo y permiso).
- **SSE 401/403:** el gestor deja de reintentar ante ambos. 401 → `onUnauthorized` (redirige al ingreso, sin cambios);
  403 → estado `forbidden`, aviso «Sin permiso para recibir actualizaciones en vivo» y NO reconexión (ni por backoff ni
  al volver la pestaña). En `forbidden` las listas se refrescan por el polling de respaldo (`fallbackInterval`), para
  que no queden congeladas sin canal en vivo.
- **RF-TR-06 en el panel:** la API ya exponía `GET /testrail/plans/:planId` y `GET /testrail/runs/:trRunId/tests`
  (`testrail.read`, qa); no se añadieron rutas. «Nueva ejecución» reemplaza la casilla «Publicar en TestRail» por el destino
  «Corrida nueva | Plan o corrida existente | No publicar». En «existente» se busca un Test Plan por ID y se elige una de
  sus corridas abiertas (las cerradas aparecen deshabilitadas) o se verifica una corrida por ID; `closeExistingRun`
  queda desactivado por defecto con aviso de irreversibilidad (ESP §8). El cuerpo de `POST /runs/preview` y `POST /runs`
  lleva `testrail: {mode:'existente', trRunId, closeExistingRun}`; sin corrida elegida no hay vista previa.
- **Lint:** `pnpm lint` queda en 0 errores y 0 advertencias sin cambiar comportamiento: `import type` en lugar de
  `import()` de tipos, sentencia `if/else` en lugar de ternario con efectos, importaciones y `any` sin uso/explícitos
  (tipos mínimos o `eslint-disable-next-line` justificado en dobles de prueba de forma libre), directivas
  `react-hooks/exhaustive-deps` eliminadas (el plugin no está configurado; se conservó el motivo como comentario),
  `no-console` desactivado solo en `**/scripts/**` (CLI), `/* global */` en `apps/web/scripts/size.mjs`.
