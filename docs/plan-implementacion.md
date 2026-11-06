# Plan de implementación — Katalyst (DeltaX QA Runner)

Documento interno de coordinación. Fuente de requisitos: `Especificación_Requerimientos/Especificación_Requerimientos.md`
(en adelante **ESP**) y `Especificación_Requerimientos/arquitectura-deltax-qa-runner-aws.md` (**ARQ**). Referencia visual:
`Especificación_Requerimientos/screens/capturas/*.png` (26 capturas) y su análisis en `docs/ui-capturas.md`.

Toda pieza de código y test debe citar los IDs RF-xx / RNF-xx que implementa (comentario de cabecera o nombre de test).
Toda decisión no cubierta por la ESP se registra en `docs/decisiones.md` (formato `D-NNN`).

## 1. Estructura del monorepo (pnpm workspaces)

```text
kevin/
  package.json                 # scripts raíz: build, test, lint, typecheck, coverage
  pnpm-workspace.yaml          # packages/*, apps/*, qa-tests
  tsconfig.base.json           # strict: true, noUncheckedIndexedAccess, exactOptionalPropertyTypes false
  .nvmrc / .node-version       # 24 (Node 24 LTS)
  .gitleaks.toml, .gitignore, .editorconfig, .env.example
  packages/shared/             # @katalyst/shared — contratos y lógica pura (sin IO)
  apps/api/                    # @katalyst/api — Fastify + Prisma + BullMQ (procesos: api, control)
  apps/runner/                 # @katalyst/runner — supervisor del host + ejecutor de shard
  apps/web/                    # @katalyst/web — React + Vite + TanStack + Tailwind + shadcn/ui
  apps/recorder/               # @katalyst/recorder — Electron (asistente local de grabación)
  qa-tests/                    # repositorio de tests Playwright (plantilla del repo real `qa-tests`)
  infra/terraform/             # bootstrap/ + internal/ (ARQ §5)
  deploy/                      # docker-compose.yml, Caddyfile, Dockerfiles, scripts de backup/restore
  docs/                        # decisiones.md, trazabilidad.md, costos.md, ui-capturas.md, operacion.md, ...
```

## 2. Versiones fijadas (verificar al instalar; registrar en docs/decisiones.md)

Node 24 LTS · pnpm 10 · TypeScript 5.x · Fastify 5 · Zod 3 (o 4 si todos los plugins lo soportan; una sola versión
en todo el repo) · Prisma 6 · PostgreSQL 16 · Redis 7 · BullMQ 5 (Job Schedulers API) · Playwright 1.5x (misma versión
exacta en runner, qa-tests e imagen `mcr.microsoft.com/playwright:v1.5x.y-noble`) · React 19 · Vite 6/7 · TanStack
Router/Query/Table/Form/Store estables · Tailwind 4 · Recharts 2/3 · Electron estable · Vitest 3 · Pino 9.
Sin beta/RC. Una sola versión de cada dependencia compartida (usar `catalog:` de pnpm si conviene).

## 3. Procesos y puertos (desarrollo local)

| Proceso | Paquete / entrada | Puerto |
| --- | --- | --- |
| API HTTP (`/api/v1`, `/healthz`, `/readyz`, `/metrics`, OpenAPI en `/api/docs`) | `apps/api` `src/main.api.ts` | 3000 |
| Control (planificador ≤15 s, reconciliador, publicador outbox, watchdog de leases ≤15 s, evaluador de umbrales 60 s, limpieza diaria, sync TestRail horaria) | `apps/api` `src/main.control.ts` | — |
| Supervisor del host (consume BullMQ `run-shards`, lanza ejecutores aislados, cancela árbol de procesos) | `apps/runner` `src/main.supervisor.ts` | — |
| Ejecutor de shard (un proceso/contenedor por shard; sin acceso a Docker/BD/Redis; solo HTTP a la API con token de lease) | `apps/runner` `src/main.executor.ts` | — |
| Panel (Vite dev, proxy `/api` → 3000) | `apps/web` | 5173 |
| Visor de reportes (origen separado, CSP estricta, sin cookies del panel) | `apps/api` `src/main.reports.ts` | 3001 |
| PostgreSQL / Redis / MinIO (dev) | — | 5432 / 6379 / 9000 |

Variables de entorno: definidas y validadas con Zod en `apps/api/src/config.ts` y `apps/runner/src/config.ts`;
ejemplo en `.env.example` (sin valores secretos reales). Secretos se leen por **referencia** (`secret_ref`) mediante
`SecretProvider` con implementaciones `env` (dev: `KATALYST_SECRET__<REF>`), `file` y `ssm` (AWS SSM SecureString).

## 4. Contratos internos clave

### 4.1 Paquete `@katalyst/shared`
- `schemas/` Zod: DTOs de toda la API `/api/v1` (requests/responses), enums de estados (ESP §7, §13.2), códigos de
  error estables, paginación por cursor `{items, nextCursor, hasNext, total?}` (limit 1..100, default 25).
- `manifest/`: esquema del manifiesto de tests (ver 4.2) + validador (unicidad UUID, correspondencia con
  `playwright --list --reporter=json`, casos existentes, clasificación, divergencias título/manifiesto).
- `schedule/`: cálculo de ocurrencias en zona IANA (cron múltiple + dedupe por instante, DST: hora inexistente se
  omite, repetida solo primera), generación de crons desde editor visual (días, hora fija o rango+intervalo; ej.
  L-V 08:00–18:00 c/30 → `0,30 8-17 * * 1-5` + `0 18 * * 1-5` = 21 ocurrencias), validación intervalo mínimo 5 min,
  próximas N ocurrencias. Único servicio lógico usado por preview, admisión y reconciliación (ESP §13.5).
- `aggregation/`: `outcome` de corrida, agregado por caso (ESP §13.4 tabla), mapeo a `status_id` de TestRail (ESP §8),
  flaky score (ESP §13.1).
- `perf/`: estadísticas DXMon (p95 por rango `ceil(0.95n)` base 1, censura de timeouts, error_rate, timeout_rate,
  over_29s estrictamente > 29 000 ms, mínimos de muestra ≥ 20) — ESP §13.8.
- `sanitize/`: sanitización de textos/URLs/JSON/HTML (tokens, JWT, cookies, Authorization, emails, query params
  sensibles, canarios) — ESP §13.7, RNF-SEG-02.
- `rbac/`: roles `qa < dev < admin`, rol `servicio`; matriz de permisos por ruta.

### 4.2 Manifiesto de tests (`qa-tests/katalyst.manifest.json`, autoritativo — ESP §10 regla 9, RF-CAT-05)
```json
{
  "schemaVersion": 1,
  "tests": [
    {
      "stableKey": "uuid-v4",
      "file": "tests/oc/ordenes-carga.spec.ts",
      "title": "C1234 Abrir Órdenes de carga y cambiar a Distribuidores @oc @humo",
      "cases": ["C1234"],
      "tags": ["@oc", "@humo"],
      "classification": "lectura",           
      "parameterKeys": ["default"],
      "writeIdempotencyApproved": false,
      "owner": "qa-automation"
    }
  ]
}
```
`classification` ∈ `lectura | escritura | sin_clasificar`; `@escritura` es etiqueta **derivada** de la clasificación.
El hash SHA-256 del manifiesto canónico se guarda en el snapshot y el ejecutor lo revalida (ESP §13.1).

### 4.3 Asignación de shard y API de worker
- Supervisor recibe de BullMQ solo `{ runId, shardId }`. Pide a la API (`POST /api/v1/worker/claim`, token de servicio
  del supervisor) un **lease** atómico: respuesta `{ leaseId, generation, leaseToken(expirable, alcance shard),
  assignment: { gitCommit, manifestHash, tests:[{stableKey,file,title,parameterKey,classification,retries}],
  environment:{appUrl,apiUrl,isProduction}, testUserRef, timeouts, artifactPolicy, runtime } }`.
- El supervisor resuelve el secreto del usuario de prueba y lo monta en tmpfs para el ejecutor (nunca en argumentos ni
  env visibles; ESP §13.7). El ejecutor solo habla con la API usando `leaseToken` en `Authorization`.
- Callbacks del ejecutor (todos con `leaseId` + `generation` como fencing; 409 si obsoleto; idempotentes por clave):
  `POST /worker/heartbeat` (cada 15 s; respuesta incluye `cancelRequested`),
  `POST /worker/attempts` (inicio de intento, antes de despachar),
  `POST /worker/results` (resultado final de intento/test, clave `(runResultId, attemptNo)`),
  `POST /worker/artifacts/upload` (devuelve URL de carga acotada ≤ 5 min o carga directa multipart en dev),
  `POST /worker/complete` (fin de shard).
- Expiración de lease 75 s desde último heartbeat; watchdog ≤ 15 s; recuperación una sola vez (ESP §13.3).

### 4.4 Eventos en vivo
SSE `GET /api/v1/events/stream` (un canal por pestaña, cookie de sesión, `Last-Event-ID`, secuencia persistida en tabla
`event_log`), eventos `{id, seq, type, entity, entityId, version, data}` sanitizados. `GET /runs/{id}/events` como
alternativa acotada.

### 4.5 Adaptadores con interfaz + implementación de prueba
`TestRailClient` (HTTP real + fake en memoria para tests), `GitProvider` (GitHub y GitLab; plataforma pendiente
ESP §12), `Notifier` (correo SMTP, Slack webhook, Teams webhook; canal pendiente), `AiProvider` (Anthropic Claude,
modelo configurable, presupuesto por solicitud), `ArtifactStore` (S3 / MinIO / filesystem dev), `SecretProvider`,
`IdentityProvider` (login propio con argon2id; OIDC corporativo opcional, pendiente ESP §12).

## 5. Reglas para todos los agentes
1. Leer ESP completa antes de escribir código de su área. Cumplir cada regla aplicable de §13 y §17.
2. Español en UI, mensajes de usuario y documentación; identificadores de código en inglés salvo valores de dominio
   definidos en la ESP (estados `en_cola`, `lectura`, etc., se usan tal cual).
3. Ningún secreto, token ni dato real en código, logs, fixtures o reportes. Fixtures sintéticos.
4. TypeScript estricto; tests con Vitest; nombres de test incluyen el ID RF/RNF.
5. No tocar archivos fuera del área asignada; si se necesita un cambio en `@katalyst/shared` o en el esquema Prisma,
   anotarlo en `docs/pendientes-integracion.md` en lugar de editarlo (salvo que la tarea lo autorice).
6. Decisiones abiertas de ESP §12 (región AWS, plataforma Git, canal, IdP, proveedor IA, etc.) NO se resuelven: se
   implementa la interfaz con adaptadores configurables y se deja la elección por configuración.
