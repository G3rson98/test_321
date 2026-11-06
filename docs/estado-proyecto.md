# Estado del proyecto — pausa del 6 de noviembre de 2026

Proyecto pausado a pedido del usuario (límite de tokens). Este documento permite retomar sin rehacer trabajo.
Al pausar, **todos los paquetes pasan `typecheck`** (shared, api, runner, web, recorder, qa-tests).

## Cómo retomar
```bash
export PATH=/opt/homebrew/opt/node@24/bin:$HOME/.local/katalyst-bin:/opt/homebrew/opt/postgresql@16/bin:$PATH
cd /Users/gersonolivarojas/Documents/Delta/kevin
brew services start postgresql@16 && brew services start redis
pnpm install
pnpm -r typecheck && pnpm -r test
```
Documentos de coordinación (leer en este orden): `docs/plan-implementacion.md`, `docs/fase2-coordinacion.md`,
`docs/pendientes-integracion.md`, `docs/decisiones.md`, `docs/trazabilidad.md`, `docs/ui-capturas.md`.
Para dependencias o cambios de Prisma usar `scripts/with-lock.sh` si hay varios agentes en paralelo.

## Fase 1 — TERMINADA
| Área | Estado | Notas |
| --- | --- | --- |
| Análisis de 26 capturas | ✅ | `docs/ui-capturas.md` |
| Base: workspace, `@katalyst/shared`, Prisma (51 modelos) | ✅ | 244 tests shared (cobertura ~99 %), 38 tests api base |
| Infraestructura Terraform + deploy Compose/Caddy | ✅ | fmt/validate OK, 6/6 `terraform test` offline; sin apply |
| `qa-tests` (5 tests, manifiesto, validador) | ✅ | `playwright --list` OK; sin ejecución real (Bloque 0) |

## Fase 2 — PARCIAL
| Agente | Estado al pausar | Qué falta |
| --- | --- | --- |
| **API-C** (perf, alertas, notificaciones, grabaciones, dispositivos, IA, exportaciones) | ✅ terminado | 170 tests api en verde al terminar. Pendientes en `docs/pendientes-integracion.md` (schemas de shared, variables a `config.ts`) |
| **RECORDER** (Electron) | ✅ terminado | 84 tests + humo real en macOS. Falta verificar instalador NSIS en Windows 11 |
| **API-A** (auth, users, audit, environments, testrail, catalog, suites, integrations, health, primitivas `src/lib`) | ⏸ detenido a mitad | Estaba agregando el schema del payload del trabajo `catalog-listing` a shared y luego el servicio de catálogo (`POST /tests/refresh`, `GET /tests`, revisión de vínculos, flaky). Revisar qué módulos quedaron completos, terminar catálogo, medir cobertura TestRail ≥70 %, actualizar trazabilidad |
| **API-B** (runs, worker, schedules, events, artifacts, control loops, reports) | ✅ terminado (2026-11-06) | 53 tests api-b en verde; cobertura `scheduler.ts` 96/80 %, `results.ts` 90/73 % (líneas/ramas). Contrato final con el supervisor en `docs/pendientes-integracion.md` (D-049) para que RUNNER lo verifique |
| **RUNNER** (supervisor + ejecutor + reporter) | ✅ terminado (2026-11-06) | 81 tests en verde (15 archivos), incluidos e2e con Chromium real (`test/e2e`) e integración contra la API real con PostgreSQL `katalyst_test_runner` + Redis 4 (`test/integration/api-real.test.ts`: corrida `terminada/fallido` y cancelación < 30 s). Contrato D-049 verificado (D-051). Pendientes: `[RUNNER→API-B]` `/_store/*` fs y `environment.name` en el claim, `[RUNNER→qa-tests]` compuerta de intento; launcher `docker` sin ensayo real |
| **WEB** (panel 26 pantallas) | ✅ terminado (2026-11-06, D-052) | 26 pantallas + preferencias, asistente, `/dispositivos/vincular`, 403/404. MSW validado contra schemas de shared; 6 archivos / 65 tests Vitest; JS inicial 203 KiB gzip (`size` ≤ 250). Pendientes `[WEB→API-*]` en pendientes-integracion.md; falta selector de Test Plan/corrida existente (RF-TR-06) y verificación contra API real en fase 3 |

## Fase 3 — PENDIENTE (integración y aceptación)
1. Terminar lo detenido de fase 2 (relanzar un agente por área con este documento y su informe pendiente).
2. Resolver `docs/pendientes-integracion.md` sección "Pendientes abiertos" (contratos entre áreas).
3. Prueba extremo a extremo local: API + control + supervisor (launcher `process`) + web contra PostgreSQL/Redis reales
   y un TestRail fake; corrida manual, programación, cancelación, caída de worker, outbox con TestRail caído.
4. Reemplazar validador local de qa-tests por `@katalyst/shared/manifest`.
5. `gitleaks` (instalar) + ensayo de canarios (ESP §13.7). Ensayo RNF-REN-01 (5.000 casos, 10 usuarios).
6. `README.md` raíz (instalación < 30 min, RNF-MAN-02) y completar `docs/trazabilidad.md` (76 IDs).

## Bloqueos externos (decisiones del equipo, ESP §12)
IDs reales de TestRail y acceso API · ambiente staging DeltaX + usuario de prueba (MFA) · scripts DXMon legados ·
plataforma Git (GitHub/GitLab) · canal de notificación · proveedor/clave IA · región/presupuesto AWS · IdP del panel.

## Recursos locales instalados
Homebrew: node@24, postgresql@16, redis, terraform, caddy, docker-compose, shellcheck, bash.
Chromium de Playwright en `~/Library/Caches/ms-playwright`. Para liberar recursos mientras está pausado:
`brew services stop postgresql@16 redis`.
