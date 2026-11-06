# Fase 2 — reglas de coordinación entre agentes paralelos

Agentes activos en paralelo: **API-A** (identidad, configuración, TestRail, catálogo), **API-B** (ejecución,
programación, worker, eventos, artefactos, procesos de control), **API-C** (rendimiento, alertas, notificaciones,
grabaciones, dispositivos, IA, exportaciones), **RUNNER**, **WEB**, **RECORDER**.

## Lecturas obligatorias (todas, antes de escribir código)
1. `Especificación_Requerimientos/Especificación_Requerimientos.md` (ESP) completa.
2. `Especificación_Requerimientos/arquitectura-deltax-qa-runner-aws.md` (ARQ).
3. `docs/plan-implementacion.md`, `docs/pendientes-integracion.md`, `docs/decisiones.md`, este archivo.
4. Código existente de `packages/shared/src` (contratos: NO reinventar DTOs, enums, errores, rbac `ROUTES`, schedule,
   aggregation, perf, sanitize, manifest, csv) y `apps/api/prisma/schema.prisma`.

## Entorno
```bash
export PATH=/opt/homebrew/opt/node@24/bin:$HOME/.local/katalyst-bin:/opt/homebrew/opt/postgresql@16/bin:$PATH
cd /Users/gersonolivarojas/Documents/Delta/kevin
```
PostgreSQL (rol `katalyst`/`katalyst_dev`, CREATEDB) y Redis ya corren como servicios locales.

## Reglas para evitar choques
- **Dependencias**: toda operación que modifique `pnpm-lock.yaml`/`node_modules` va SIEMPRE con candado:
  `scripts/with-lock.sh pnpm --filter <paquete> add <dep>@<versión-exacta-estable>` (o `scripts/with-lock.sh pnpm install`).
  Preferir versiones del `catalog:` de `pnpm-workspace.yaml`; si agregas una nueva entrada al catálogo, hazlo bajo el candado.
- **Esquema Prisma**: solo si es imprescindible. Bajo candado: editar `schema.prisma` (cambios aditivos), crear migración
  nueva con `pnpm exec prisma migrate dev --name <area>_<cambio>` contra la BD `katalyst`, `prisma generate`, y anotar el
  cambio en `docs/decisiones.md`. Nunca editar migraciones existentes ni renombrar/eliminar columnas.
- **BD de pruebas propia por agente**: `katalyst_test_api_a`, `katalyst_test_api_b`, `katalyst_test_api_c`,
  `katalyst_test_runner` (créala con `createdb -U katalyst <nombre>` y `prisma migrate deploy`). Redis: usa un prefijo
  de claves BullMQ propio en tests (`katalyst-test-<area>`) o un índice de BD Redis propio (A=1, B=2, C=3, RUNNER=4).
- **Archivos**: cada agente edita SOLO su área (ver tabla). Para necesidades en otra área, añade una línea en
  `docs/pendientes-integracion.md` sección "Pendientes abiertos" con prefijo `[DE→PARA]`.
- `packages/shared`: solo API-A puede **añadir** (no cambiar) exports si un contrato falta; los demás lo piden en
  pendientes. Nunca romper exports existentes.
- `docs/decisiones.md`: añadir decisiones al final, con el siguiente número libre `D-NNN` (relee el archivo antes de
  escribir para no duplicar números). `docs/trazabilidad.md`: actualiza solo las filas de tus RF/RNF.
- No inicializar git, no hacer commits. No ejecutar tests contra `cbc.deltax.la`/`fmsapi.deltax.la` (producción).

## Propiedad de archivos

| Área | Archivos |
| --- | --- |
| API-A | `apps/api/src/lib/{auth,audit,outbox,events-publish,secrets,pagination,http-guard,ssrf,crypto-tokens,metrics}.ts`, módulos `auth, users, audit, environments, testrail, catalog, suites, integrations, health`, `src/control/testrail-sync.ts`, `src/control/outbox-publisher.ts` (motor genérico + handlers TestRail), `src/adapters/testrail/**`, `src/adapters/git/**` (lectura de manifiesto/lista vía runner aislado), `app.ts`, `config.ts` (añadir variables, no romper), `modules/index.ts` |
| API-B | módulos `runs, worker, schedules, events, artifacts`, `src/services/{run-planner,run-admission,capacity,leases,results,cancellation,scheduler}.ts`, `src/control/{scheduler-loop,reconciler,lease-watchdog,cleanup,dispatcher}.ts`, `main.control.ts`, `main.reports.ts`, `src/adapters/artifact-store/**` |
| API-C | módulos `perf, alerts, notifications, recordings, devices, generate, exports`, `src/control/{perf-evaluator,perf-rollup}.ts`, `src/adapters/{notifier,ai,git-pr}/**` (git-pr = abrir rama/PR GitHub/GitLab) |
| RUNNER | `apps/runner/**` |
| WEB | `apps/web/**` |
| RECORDER | `apps/recorder/**` |

## Primitivas compartidas de la API (las crea API-A PRIMERO, en su primera hora; firmas fijas)
Los demás agentes de API las importan; si aún no existen, trabajen primero en lógica pura/servicios y revisen
periódicamente. No las reimplementen.

```ts
// src/lib/auth.ts
export type Principal =
  | { kind: 'panel_user'; id: string; role: 'qa' | 'dev' | 'admin'; email: string; sessionId: string }
  | { kind: 'api_token'; id: string; role: 'qa' | 'dev' | 'admin'; scopes: string[] }
  | { kind: 'service'; id: string; scopes: string[] }            // supervisor del host / publicador
  | { kind: 'lease'; id: string; leaseId: string; shardId: string; runId: string; generation: number } // ejecutor
  | { kind: 'device'; id: string; userId: string; role: 'qa' | 'dev' | 'admin' };
declare module 'fastify' { interface FastifyRequest { principal?: Principal; requestId: string } }
export function requirePermission(permission: Permission): preHandlerHookHandler; // usa @katalyst/shared/rbac
export const authPlugin: FastifyPluginAsync; // resuelve cookie __Host-katalyst_session, Bearer token, lease token
// src/lib/audit.ts
export async function recordAudit(tx: Prisma.TransactionClient, e: { actor: Principal | 'system'; action: string; entity: string; entityId?: string; diff?: unknown }): Promise<void>;
// src/lib/outbox.ts
export async function enqueueOutbox(tx: Prisma.TransactionClient, d: { operation: OutboxOperation; dedupKey: string; payload: unknown; runId?: string; expiresAt?: Date; notBefore?: Date }): Promise<{ id: string; created: boolean }>;
export function registerOutboxHandler(op: OutboxOperation, h: (delivery: OutboxDelivery, ctx: OutboxCtx) => Promise<OutboxHandlerResult>): void;
// src/lib/events-publish.ts  (persistir en event_log con seq dentro de la misma transacción; notificar vía Redis pub/sub tras commit)
export async function publishEvent(tx: Prisma.TransactionClient, e: { type: EventType; entity: EventEntity; entityId: string; version: number; data: unknown }): Promise<void>;
// src/lib/pagination.ts
export function paginate<T extends { id: string }>(...): { items: T[]; nextCursor: string | null; hasNext: boolean };
// src/lib/secrets.ts
export interface SecretProvider { get(ref: string): Promise<string>; } export function getSecretProvider(): SecretProvider; // env | file | ssm
// src/lib/metrics.ts   (registro Prometheus prom-client; counters/gauges con baja cardinalidad)
```
