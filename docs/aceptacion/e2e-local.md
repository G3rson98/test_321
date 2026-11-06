# Aceptación — extremo a extremo local (stack de desarrollo)

Fecha del ensayo: 2026-11-06 · Equipo: macOS 26 (Apple Silicon), Node 24.22.2, PostgreSQL 16 y Redis locales ·
BD `katalyst_accept` (migrada con `prisma migrate deploy`), Redis índice 6, prefijo de colas `katalyst-accept`.
Sin Docker, sin AWS y **sin tráfico a cbc.deltax.la / fmsapi.deltax.la**: DeltaX y TestRail son dobles locales.

## 1. Qué se levanta

| Proceso | Puerto | Origen | Notas |
| --- | --- | --- | --- |
| `fake-testrail` | 4010 | `scripts/fake-testrail.mjs` | API v2 en memoria: `get_projects`, `get_suites`, `get_sections`/`get_cases` paginados (`offset/limit/_links.next`, máx. 250), `get_priorities`, `get_case_types`, `get_runs`, `get_run`, `get_tests`, `get_results_for_run`, `get_attachments_for_test`, `add_run`, `add_results_for_cases`, `add_attachment_to_result` (multipart, guarda el archivo para auditarlo), `close_run`. Basic auth con la API key de desarrollo. Inspección: `GET /_fake/state`, fallas simuladas: `POST /_fake/fail {op,status,times}` |
| `fake-deltax` | 4020 | `scripts/fake-deltax.mjs` | Fixture HTML: login («Usuario»/«Contraseña»/«Iniciar sesión»), `users/api/users/current`, servicios de la raíz (`place`, `setting/i18n`, `notification/user`, `dashboard/*`), redirección a `/controlCenterShipper` con «Informe operativo», `/espera` (cancelación) y `/canario` (solo con `FAKE_DELTAX_CANARIES`) |
| `api` | 3000 | `apps/api/src/main.api.ts` | `ARTIFACT_STORE=fs`, `GIT_PROVIDER=local`, `SSRF_ALLOW_LOOPBACK/HTTP=true` y allowlist `127.0.0.1,localhost` (solo desarrollo) |
| `reports` | 3001 | `apps/api/src/main.reports.ts` | Visor en origen separado y `/_store/*` del almacén fs |
| `control` | — | `apps/api/src/main.control.ts` | Planificador (tick 5 s), outbox (2 s), watchdog, reconciliador, sync TestRail, limpieza |
| `supervisor` | — | `apps/runner/src/main.supervisor.ts` | Launcher `process`, Chromium real de Playwright 1.65.0, checkout `git` del repo bare local, `KATALYST_CHECKOUT_INSTALL=never` (Playwright enlazado en `$KATALYST_STACK_DIR/node_modules`) |

Repositorio de tests: `git init --bare $KATALYST_STACK_DIR/qa-tests.git` con el contenido de `qa-tests/` (sin
`node_modules`) + `scripts/dev-stack/qa-tests-local/tests/local/humo-local.spec.ts` (C900006–C900009) y su manifiesto
fusionado. Los casos C900001–C900009 existen en el TestRail falso junto con 600 casos de catálogo sin automatizar.
Secretos de desarrollo aleatorios en `$KATALYST_STACK_DIR/secrets.env` (0600, fuera del repo); la credencial
`ksv_` del supervisor se emite con `bootstrap-admin --service-credential` y se guarda en `supervisor.token` (0600).

## 2. Comandos

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$HOME/.local/katalyst-bin:/opt/homebrew/opt/postgresql@16/bin:$PATH
createdb -h localhost -U katalyst katalyst_accept            # una vez (o usar la BD `katalyst` por defecto)
export DATABASE_URL=postgresql://katalyst:katalyst_dev@localhost:5432/katalyst_accept
export REDIS_URL=redis://localhost:6379/6 QUEUE_PREFIX=katalyst-accept KATALYST_STACK_DIR=$TMPDIR/katalyst-accept
pnpm dev:stack                                               # = scripts/dev-stack.sh start (migra y arranca todo)
umask 077; printf '%s' 'una-clave-larga-de-admin' > $KATALYST_STACK_DIR/admin.pass
pnpm dev:seed < $KATALYST_STACK_DIR/admin.pass               # admin (stdin), TestRail falso, sync, ambiente, catálogo
pnpm dev:e2e  < $KATALYST_STACK_DIR/admin.pass               # verificación HTTP extremo a extremo (JSON por stdout)
pnpm dev:stack:stop                                          # detiene todo (y ejecutores huérfanos)
```

`scripts/dev-stack.sh status|env|restart|rebuild-repo` ayudan a depurar; los logs JSON quedan en
`$KATALYST_STACK_DIR/logs/*.log`. El panel (`pnpm --filter @katalyst/web dev`, puerto 5173) usa el proxy `/api` hacia
la API de este stack.

## 3. Resultado (`scripts/e2e-local.ts`, ejecución completa de 136 s)

| Paso | Verificación | Resultado |
| --- | --- | --- |
| Login | `POST /auth/login` → cookie `HttpOnly` + token CSRF; `/readyz` BD+Redis | ✅ |
| Semilla | admin por stdin, conexión TestRail (`env:KATALYST_SECRET__TESTRAIL_FAKE`), prueba de conexión, ambiente `staging-local` (no producción), usuario de prueba de solo lectura | ✅ |
| Sync TestRail | `POST /testrail/sync` → `exitosa`: 1 proyecto, 2 suites, 4 secciones, **609 casos en 5 páginas** (la suite 1 supera 250 casos: paginación `_links.next` ejercitada) | ✅ |
| Catálogo | `POST /tests/refresh` → cola `catalog-listing` → supervisor (checkout del commit + `playwright --list` aislado) → `POST /worker/catalog/listing` → revisión `completa`, **9 tests**, 518–525 ms | ✅ |
| Vista previa | `POST /runs/preview` C900006+C900007+C900004: 3 casos ejecutables, 3 tests, 0 bloqueos | ✅ |
| Idempotencia | `POST /runs` 201; repetido con la misma `Idempotency-Key` → 200 y la misma corrida | ✅ |
| Corrida manual | `en_cola → preparando → corriendo → terminada` en **11 s**, outcome `fallido`: C900006 `pasado`, C900004 (test real de qa-tests: arranque + servicios + «Informe operativo») `pasado`, C900007 `fallido` (2 intentos `asercion`, retries=1) | ✅ |
| Evidencia | 5 artefactos (2 logs por resultado, log del shard, reporte JSON, reporte HTML), **todos `sanitizado`**; el visor sirve el HTML firmado (HTTP 200) y la URL es de un solo uso (segundo acceso 404) | ✅ |
| Publicación TestRail | outbox → `add_run` («QA Runner · Regresión FMS · staging-local · … [katalyst-run:<id>]») → `add_results_for_cases` (status 1/5/1) → `close_run`; `syncStatus=sincronizada`, run cerrada en el TestRail falso | ✅ |
| Cancelación | C900008 corriendo 3,5 s → `POST /runs/:id/cancel` → pub/sub `runs:control` → árbol detenido → `complete cancelado`: **cancelada en 316 ms** (API: 224 ms entre `cancel_requested_at` y `finished_at`); shard `cancelado`, intento `cancelado/cancelacion`, sin `run.cancel_unconfirmed` | ✅ |
| Programación | hora fija L–V 03:00 y 15:30 (La Paz) → `GET /schedules/:id/next?count=5`: 09-11 03:00, 09-11 15:30, 10-11 03:00, 10-11 15:30, 11-11 03:00 | ✅ |
| Disparo real | programación a «ahora + 2 min» → el planificador crea la corrida `programada` (ocurrencia `admitida`) a los 112 s de crearla → `terminada/pasado` | ✅ |
| Auditoría | `auth.login`, `panel_user.create`, `testrail_connection.update/test`, `testrail.sync`, `environment.create`, `test_user.create`, `catalog.refresh`, `run.create`, `run.cancel`, `schedule.create/pause`, `run.schedule` | ✅ |

### Problemas encontrados y corregidos durante el ensayo
1. **Sanitizador vs. verificador (D-053, `packages/shared/src/sanitize/verify.ts`):** el `error-context.md` que
   Playwright adjunta a una falla incluye el código fuente del test; una línea con
   ``page.goto(`/canario?token=${…}`)`` se enmascaraba como `?token=[REDACTED:secret_assignment]}` pero el
   verificador tomaba el `}` como parte del valor y lo contaba como residual ⇒ el log de la falla **y el reporte HTML
   completo** quedaban `fallido` (bloqueados) aunque no contenían secretos. Corregido + prueba de regresión.
2. Primer intento: C900004 fallaba con `error_aplicacion` porque la fixture no emitía los servicios de la raíz;
   se amplió la fixture (no era un defecto del producto). El reintento de C900004/C900007 funcionó como se espera.

## 4. Qué NO cubre este ensayo
- DeltaX real (Cognito, MFA, selectores de Bloque 0) ni TestRail real: siguen bloqueados por ESP §12 / Bloque 0.
- Launcher `docker` (imagen oficial de Playwright, red aislada, límites de cgroup): requiere Docker en el host.
- Caída de worker con lease vencido, TestRail caído con reintento 24 h y reinicio de Redis: cubiertos por las
  suites de integración de api/runner (`test/api-b-*.test.ts`, `test/integration/api-real.test.ts`), no
  repetidos aquí; `POST /_fake/fail` del TestRail falso permite ensayarlos manualmente con este stack.
- Panel web (lo valida el agente WEB) y SSE desde el navegador.
