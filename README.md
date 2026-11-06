# Katalyst (DeltaX QA Runner)

Plataforma interna de QA para **FMS DeltaX**: sincroniza casos de **TestRail**, mantiene un catálogo de tests
**Playwright** versionado en Git (`qa-tests`), los ejecuta bajo demanda o programados en Chromium aislado, publica
los resultados en TestRail con evidencia sanitizada, monitorea el rendimiento de la aplicación (suite DXMon) y
permite grabar tests nuevos con un asistente local (Windows 11). Panel web en español (`America/La_Paz`).

Especificación: [`Especificación_Requerimientos/Especificación_Requerimientos.md`](Especificación_Requerimientos/Especificación_Requerimientos.md)
(ESP) · Arquitectura AWS: [`Especificación_Requerimientos/arquitectura-deltax-qa-runner-aws.md`](Especificación_Requerimientos/arquitectura-deltax-qa-runner-aws.md).

> **Estado (2026-11-06):** código de las fases 1–2 completo y probado localmente (API 234 pruebas, runner 82,
> shared 248, extremo a extremo local en verde). **No operativo contra DeltaX/TestRail reales** hasta cerrar el
> Bloque 0 y las decisiones externas de ESP §12 (ver [§9](#9-decisiones-abiertas-y-bloqueos)). Seguimiento:
> [`docs/estado-proyecto.md`](docs/estado-proyecto.md).

## 1. Arquitectura

```mermaid
flowchart LR
  subgraph Usuarios
    QA[QA / Dev / Admin<br/>navegador]
    REC[Asistente local<br/>Electron + codegen]
  end
  subgraph Host["Host único (EC2 + Docker Compose)"]
    CADDY[Caddy<br/>TLS + allowlist CIDR]
    WEB[web<br/>React 19 + Vite]
    API[api :3000<br/>Fastify /api/v1, SSE]
    REP[reports :3001<br/>visor en origen separado]
    CTL[control<br/>planificador, outbox,<br/>watchdog, sync, limpieza]
    SUP[supervisor<br/>BullMQ + Docker]
    EXE[ejecutores efímeros<br/>Playwright + Chromium]
    PG[(PostgreSQL 16<br/>fuente de verdad)]
    RD[(Redis<br/>BullMQ + pub/sub)]
    GW[worker-gw<br/>/api/v1/worker/*]
  end
  S3[(S3 privado<br/>evidencia y backups)]
  SSM[SSM Parameter Store<br/>secretos]
  TR[TestRail API]
  DX[FMS DeltaX<br/>staging / producción]
  GIT[Repo qa-tests<br/>GitHub/GitLab]

  QA --> CADDY --> WEB & API & REP
  REC -->|token de dispositivo| CADDY
  API & CTL & REP --> PG
  API & CTL --> RD
  CTL -->|outbox| TR
  CTL -->|run-shards| RD --> SUP
  SUP -->|checkout commit aprobado| GIT
  SUP --> EXE -->|lease kls_| GW --> API
  EXE -->|solo lectura en producción| DX
  API & REP & EXE -.->|URLs firmadas ≤ 5 min| S3
  API & SUP -.-> SSM
```

Principios: PostgreSQL es la fuente de verdad (Redis es transporte reconstruible); los ejecutores no ven la BD,
Redis, el socket Docker ni secretos del backend; toda integración externa sale por **outbox** idempotente; la
evidencia se sanitiza en el ejecutor y se bloquea si no puede verificarse (ESP §13.7); un único ambiente AWS
`internal` administrado con Terraform (ESP §18). Detalle: [`docs/infraestructura.md`](docs/infraestructura.md),
contratos entre procesos: [`docs/pendientes-integracion.md`](docs/pendientes-integracion.md), decisiones
técnicas: [`docs/decisiones.md`](docs/decisiones.md).

## 2. Estructura del monorepo (pnpm workspaces)

| Ruta | Contenido |
| --- | --- |
| `apps/api` | `@katalyst/api`: API Fastify (`main.api.ts`), proceso de control (`main.control.ts`), visor de reportes (`main.reports.ts`), Prisma (`prisma/schema.prisma`, migraciones), CLI `bootstrap-admin` |
| `apps/runner` | `@katalyst/runner`: supervisor del host (`main.supervisor.ts`, launcher `docker` o `process`) y ejecutor de shard (`main.executor.ts`, reporter Playwright, sanitización de evidencia) |
| `apps/web` | `@katalyst/web`: panel (React 19, Vite, TanStack Query/Router/Table/Form, Tailwind v4, shadcn/ui) |
| `apps/recorder` | `@katalyst/recorder`: asistente local de grabación (Electron + Playwright codegen, instalador NSIS) |
| `packages/shared` | `@katalyst/shared`: contratos Zod, RBAC/rutas, sanitización, agregación, programación, manifiesto, rendimiento |
| `qa-tests` | Plantilla del repositorio de tests Playwright (manifiesto `katalyst.manifest.json`, fixtures, page objects, DXMon) |
| `deploy` | Docker Compose de producción, Dockerfiles, Caddy, Redis, scripts del host (`deploy.sh`, backups, smoke test, firewall) y systemd |
| `infra/terraform` | Terraform del ambiente único `internal` (bootstrap del state + root de aplicación) |
| `scripts` | Stack local, dobles de TestRail/DeltaX, semillas, ensayos de aceptación, carga y backup local |
| `docs` | Plan, decisiones (D-NNN), trazabilidad, operación, infraestructura, costos y actas de aceptación (`docs/aceptacion/`) |

## 3. Requisitos (desarrollo local)

- macOS o Linux; **Node 24.22.x** (`.nvmrc`) y **pnpm 10.34.x** (`packageManager`).
- **PostgreSQL 16** (extensión `pg_trgm`, la crea la migración) y **Redis 7+** locales.
- Chromium de Playwright 1.65.0 (`pnpm --filter @katalyst/runner exec playwright install chromium`).
- Opcional: Docker (launcher `docker` del supervisor, imágenes de despliegue), `gitleaks`, `shellcheck`, Terraform 1.17.

## 4. Instalación local paso a paso

```bash
# 1. Herramientas (macOS/Homebrew)
brew install node@24 postgresql@16 redis gitleaks shellcheck
export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/postgresql@16/bin:$PATH
corepack enable && corepack prepare pnpm@10.34.9 --activate      # o instalar pnpm 10.34.x
brew services start postgresql@16 && brew services start redis

# 2. Base de datos (credenciales SOLO de desarrollo, loopback)
psql -d postgres -c "CREATE ROLE katalyst LOGIN PASSWORD 'katalyst_dev' CREATEDB"
createdb -h localhost -U katalyst katalyst          # BD del stack local
createdb -h localhost -U katalyst katalyst_test     # BD de pruebas de la API

# 3. Dependencias, cliente Prisma y Chromium
pnpm install
pnpm db:generate
pnpm --filter @katalyst/runner exec playwright install chromium

# 4. Migraciones
DATABASE_URL=postgresql://katalyst:katalyst_dev@localhost:5432/katalyst pnpm --filter @katalyst/api db:deploy

# 5. Stack completo (api 3000, reports 3001, control, supervisor `process`, TestRail falso 4010, fixture DeltaX 4020)
pnpm dev:stack                                       # scripts/dev-stack.sh start (migra, crea secretos de desarrollo aleatorios)
umask 077; printf '%s' '<clave-admin-de-al-menos-12>' > ~/.katalyst-admin.pass
pnpm dev:seed < ~/.katalyst-admin.pass               # admin inicial (stdin), TestRail falso + sync, ambiente staging-local, catálogo
pnpm dev:e2e  < ~/.katalyst-admin.pass               # opcional: verificación extremo a extremo por HTTP

# 6. Panel
pnpm --filter @katalyst/web dev                      # http://localhost:5173 (proxy /api → :3000); login con el admin del paso 5
pnpm dev:stack:stop                                  # al terminar
```

El stack local no toca DeltaX ni TestRail reales: usa `scripts/fake-testrail.mjs` y la fixture
`scripts/fake-deltax.mjs`, y un repositorio git bare local con el contenido de `qa-tests`. Variables y detalles:
[`docs/aceptacion/e2e-local.md`](docs/aceptacion/e2e-local.md). Para correr procesos sueltos:
`pnpm --filter @katalyst/api dev | dev:control | dev:reports` y `pnpm --filter @katalyst/runner dev:supervisor`
con las variables de [`.env.example`](.env.example).

## 5. Pruebas, cobertura y build

```bash
pnpm typecheck                     # todos los paquetes
pnpm test                          # todas las suites (API y runner usan PostgreSQL/Redis reales: ver abajo)
pnpm --filter @katalyst/api test   # TEST_DATABASE_URL (default …/katalyst_test) y TEST_REDIS_URL (default índice 15)
pnpm --filter @katalyst/runner test       # incluye e2e con Chromium real e integración con la API real
pnpm --filter @katalyst/runner test:e2e
pnpm coverage                      # vitest --coverage por paquete (RNF-MAN-01: ≥ 70 % en TestRail, programación, resultados)
pnpm build                         # prisma generate + tsc (api, runner, shared), vite build (web), electron-vite (recorder)
pnpm --filter @katalyst/web size   # presupuesto JS inicial ≤ 250 KiB gzip (RNF-OPT-03)
pnpm lint && pnpm format:check
pnpm secrets:scan                  # gitleaks sobre el árbol de trabajo (.gitleaks.toml)
pnpm secrets:scan:git              # gitleaks sobre el historial
```

Ensayos de aceptación (sobre el stack local): `pnpm accept:canarios` (ESP §13.7), `pnpm load:seed` +
`pnpm load:explain` + `pnpm load:run -- --duration 300` (RNF-REN-01), `pnpm backup:local` (RNF-CON-04). Resultados en
[`docs/aceptacion/`](docs/aceptacion/).

## 6. Despliegue en servidor limpio con Docker Compose (objetivo < 30 min, RNF-MAN-02)

El tiempo objetivo cuenta **desde que los prerrequisitos están disponibles**; no incluye conseguirlos.

**Prerrequisitos (fuera del procedimiento):**
1. Decisiones de ESP §12 resueltas: región/cuenta AWS y techo de costo, plataforma Git, IdP del panel, canal de
   notificación, ambiente staging y usuario de prueba de DeltaX.
2. Infraestructura aplicada con Terraform (`infra/terraform/bootstrap` y `infra/terraform/internal`): VPC/EC2
   x86_64 (ensayo inicial 2 vCPU / 8 GiB, un navegador), volumen `/data`, buckets S3 de evidencia y backups, EIP,
   rol de instancia, alarmas y presupuesto. Guía: [`infra/terraform/README.md`](infra/terraform/README.md).
3. DNS: los dos hostnames (panel/API y visor de reportes) apuntando a la EIP; validación ACME (HTTP-01 o DNS-01).
4. Red: CIDR/VPN de los operadores en `allowed_cidrs`; egreso HTTPS a DeltaX, TestRail, plataforma Git, registro de
   imágenes y (si aplica) proveedor de IA/notificaciones.
5. Secretos cargados en SSM Parameter Store (`/katalyst/internal/...`): sesión, contraseña del admin inicial,
   API key de TestRail, credenciales de usuarios de prueba, token Git, webhooks/SMTP, clave pública GPG de backups.
6. Imágenes publicadas por tag + digest y paquete de versión (`deploy/` + `release.env`).

**Procedimiento** (detalle en [`docs/operacion.md` §11](docs/operacion.md)): sesión SSM al host → verificar el
user-data (`/var/log/katalyst-bootstrap.log`, `/data` montado, `docker compose version`) → copiar
`deploy/site.env.example` a `/etc/katalyst/site.env` → `deploy/scripts/deploy.sh /opt/katalyst/releases/<versión>`
(descarga imágenes por digest, backup previo si ya hay datos, migra con el servicio `migrate`, instala unidades
systemd del host, levanta `caddy api control reports supervisor postgres redis` y ejecuta el smoke test) →
`backup-postgres.sh --reason inicial` y prueba de restauración (`restore-postgres.sh`) → `smoke-test.sh --external`
desde un equipo autorizado → registrar el tiempo total. Rollback de aplicación: `deploy.sh --rollback`.

## 7. Configuración

Todas las variables, con valores de ejemplo y comentario, están en [`.env.example`](.env.example) y se validan con
Zod en `apps/api/src/config.ts` y `apps/runner/src/config.ts`. Las más importantes:

| Variable | Uso |
| --- | --- |
| `DATABASE_URL` / `DATABASE_URL_FILE`, `REDIS_URL` / `REDIS_URL_FILE` | Conexiones (en despliegue, archivos montados por el entrypoint) |
| `DATABASE_POOL_API/CONTROL/REPORTS` (10/6/3), `TOTAL_DB_POOL_BUDGET` (20) | Presupuesto de conexiones PostgreSQL (RNF-OPT-05) |
| `SECRET_PROVIDER` (`env`/`file`/`ssm`), `SSM_PREFIX`, `SECRET_FILE_DIR` | Proveedor de secretos; los secretos se configuran por **referencia** `*_REF` (`env:KATALYST_SECRET__X`, `file:…`, `ssm:/katalyst/internal/…`) |
| `SESSION_SECRET_REF`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD_REF` | Sesión del panel y admin inicial (`pnpm --filter @katalyst/api bootstrap-admin -- --email … --password-stdin`) |
| `TESTRAIL_API_KEY_REF` y conexión en BD (`PUT /testrail/connection`) | TestRail (la API key nunca sale del backend) |
| `ARTIFACT_STORE` (`s3`/`minio`/`fs`), `ARTIFACT_BUCKET`, `SIGNED_URL_TTL_SECONDS` (≤ 300) | Evidencia privada con URLs firmadas |
| `ALLOWED_TARGET_HOSTS`, `SSRF_PRIVATE_ALLOWED_HOSTS` (`SSRF_ALLOW_LOOPBACK/HTTP` solo desarrollo) | Allowlist SSRF de ambientes/TestRail |
| `GIT_PROVIDER`, `GIT_REPOSITORY`, `GIT_PROTECTED_BRANCH`, `GIT_TOKEN_REF` | Repo de tests y PR de grabaciones |
| `KATALYST_SUPERVISOR_TOKEN_REF`, `KATALYST_EXECUTOR_LAUNCHER`, `KATALYST_TESTS_REPO_URL`, `KATALYST_GLOBAL_BROWSER_CONCURRENCY` (1) | Supervisor del runner (credencial `ksv_` emitida con `bootstrap-admin -- --service-credential supervisor:<host>`) |
| `NOTIFIER_CHANNELS`, `SMTP_*`, `SLACK_WEBHOOK_REF`, `TEAMS_WEBHOOK_REF`; `AI_PROVIDER`, `AI_API_KEY_REF`, `AI_BUDGET_*` | Integraciones opcionales (pendientes de decisión, ESP §12) |

Nunca se escriben valores secretos en el repositorio (RNF-SEG-01): `pnpm secrets:scan` y el ensayo de canarios lo
verifican ([`docs/aceptacion/seguridad.md`](docs/aceptacion/seguridad.md)). En producción, rotación y revocación de
secretos: [`docs/operacion.md` §7](docs/operacion.md).

## 8. Operación

Backups diarios cifrados a S3 con verificación y prueba de restauración (RNF-CON-04), alarmas, parches, rotación
de secretos, limpieza y reconstrucción de la cola: [`docs/operacion.md`](docs/operacion.md). Costos estimados:
[`docs/costos.md`](docs/costos.md). Ensayo local de backup/restauración: [`docs/aceptacion/backup.md`](docs/aceptacion/backup.md).

## 9. Decisiones abiertas y bloqueos

**Bloque 0 (ESP §11) — sin cerrar, impide operar con datos reales:**
- IDs reales de los cuatro casos iniciales en TestRail (hoy placeholders `C900001…C900005`), acceso API y proyecto de prueba autorizado.
- Ambiente staging de DeltaX y usuario de prueba dedicado; validación del login Cognito (MFA/desafíos) y de los selectores (`TODO selector (Bloque 0)` en `qa-tests/pages`).
- Ciclo real crear/publicar/adjuntar/cerrar en TestRail; scripts DXMon legados y muestras sanitizadas.

**Decisiones externas (ESP §12):** región y capacidad AWS · techo de presupuesto, CIDRs/VPN y dominio/DNS ·
plataforma Git (GitHub/GitLab) · IdP corporativo para el panel (hoy: usuarios propios) · canal de notificaciones
(correo/Slack/Teams) · proveedor y clave de IA · política de datos/evidencia (habilitar capturas/video/trazas solo
tras demostrar enmascaramiento con canarios) · acceso local de grabación y firma del instalador Windows ·
inventario de flujos Katalon.

Pendientes técnicos conocidos: launcher `docker` sin ensayo real en el host; instalador del asistente sin ensayo
en Windows 11; enmascaramiento visual de capturas no implementado (capturas deshabilitadas por defecto).

## 10. Documentación

| Documento | Contenido |
| --- | --- |
| [`docs/estado-proyecto.md`](docs/estado-proyecto.md) | Estado y cómo retomar |
| [`docs/plan-implementacion.md`](docs/plan-implementacion.md) | Plan por fases y áreas |
| [`docs/decisiones.md`](docs/decisiones.md) | Decisiones técnicas D-001… |
| [`docs/pendientes-integracion.md`](docs/pendientes-integracion.md) | Contratos entre áreas |
| [`docs/trazabilidad.md`](docs/trazabilidad.md) | Requisito → implementación → prueba |
| [`docs/infraestructura.md`](docs/infraestructura.md), [`docs/operacion.md`](docs/operacion.md), [`docs/costos.md`](docs/costos.md) | Infraestructura, operación y costos |
| [`docs/ui-capturas.md`](docs/ui-capturas.md) | Análisis de pantallas del panel |
| [`docs/aceptacion/`](docs/aceptacion/) | Actas: extremo a extremo local, seguridad (gitleaks + canarios), rendimiento de API, backup |
| [`qa-tests/README.md`](qa-tests/README.md), [`apps/recorder/README.md`](apps/recorder/README.md), [`infra/terraform/README.md`](infra/terraform/README.md) | Guías por componente |
