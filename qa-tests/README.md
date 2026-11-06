# qa-tests — tests Playwright de Katalyst (DeltaX QA Runner)

Repositorio de tests automatizados de **FMS DeltaX** vinculados a casos de TestRail (ESP §1, §4, §10). Dentro del
monorepo es la plantilla del repositorio real `qa-tests` y un miembro del workspace pnpm (paquete privado `qa-tests`).

Requisitos cubiertos: RF-TR-03, RF-CAT-01, RF-CAT-05, RF-EJE-01, RF-EJE-05, RF-EJE-06, RF-AMB-01..03, RF-RES-02,
RF-GRB-05, RF-REN-01, RF-REN-05, RNF-SEG-01, RNF-SEG-02 (parcial: política de artefactos), RNF-SEG-04, RNF-CON-03.

## Versiones fijadas

| Componente | Versión | Nota |
| --- | --- | --- |
| `@playwright/test` | **1.65.0** (exacta, sin `^`) | Última estable en npm al 2026-11-06 (`npm view @playwright/test version`) |
| Imagen del worker | `mcr.microsoft.com/playwright:v1.65.0-noble` | Digest del índice multi-arquitectura al 2026-11-06: `sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d`. Debe coincidir con la versión del paquete (ESP §4); el runner fija tag + digest |
| Node.js | 24 LTS | `engines: >=24 <25`. `scripts/validate-manifest.ts` usa el *type stripping* nativo de Node 24 |
| TypeScript | 5.9.3 | Solo typecheck (`noEmit`); Playwright transpila los tests |
| `@types/node` | 24.19.2 | |

Al actualizar Playwright se cambian **en el mismo PR** el paquete, este README, la imagen del runner
(`apps/runner`) y los workflows de CI; el runner registra las versiones efectivas en `runtime_versions` (ESP §7).

## Estructura (ESP §10)

```text
qa-tests/
  playwright.config.ts        # project `setup` + un project por ambiente (KATALYST_ENV_NAME); solo Chromium
  auth.setup.ts               # login Cognito, validación identidad/ambiente, storageState 0600 fuera del repo
  global-teardown.ts          # borra el storageState al terminar
  katalyst.manifest.json      # manifiesto autoritativo (UUID estable, casos, clasificación, etiquetas, parámetros)
  pages/                      # Page Objects (únicos dueños de selectores) + helper Inovua
    LoginPage.ts ControlCenterPage.ts LoadOrderPage.ts WarehousePage.ts SchedulingPage.ts
    inovua.ts                 # waitForInovuaGridReady(locator) — regla 7
    services.ts               # servicios por pantalla (ESP §2) y waitForService
    selectores-excepciones.md # excepciones controladas y versionadas de clases MUI/Inovua (regla 12)
  fixtures/                   # env, errores clasificados, timeouts, perfiles de datos sintéticos, datos QA-AUTO, test extendido
  tests/
    oc/ agendamiento/ instalaciones/ arranque/   # 4 casos iniciales de Bloque 1 (lectura, @humo)
    rendimiento/dxmon.spec.ts                    # suite @rendimiento (DXMon + observación Playwright)
  tools/
    dxmon-adapter.ts playwright-observer.ts perf-contract.ts
    dxmon-allowlist.json dxmon-legacy.lock.json README-dxmon.md
    deltax_monitor.js         # (AUSENTE — bloqueo 2B; ver tools/README-dxmon.md)
  scripts/validate-manifest.ts
  .github/workflows/ci.yml  .gitlab-ci.yml        # CI de ejemplo (plataforma pendiente, ESP §12)
```

## Tests actuales

| stableKey | Archivo | Título | Clasificación |
| --- | --- | --- | --- |
| `9050dd7e-9ec9-4634-91ac-5b1ecfc8a990` | `tests/oc/ordenes-carga.spec.ts` | C900001 Abrir Órdenes de carga y recorrer Abastecimiento, Directa y Distribuidores @oc @humo | lectura |
| `254f1b1d-74af-489f-b953-a6a87cfbcf39` | `tests/agendamiento/agendamientos.spec.ts` | C900002 Abrir Agendamientos y alternar entre vista lista y calendario @agendamiento @humo | lectura |
| `cb8366a4-09c9-4701-a96f-86aa9e2b6e37` | `tests/instalaciones/instalaciones.spec.ts` | C900003 Abrir Instalaciones y ver la grilla de configuración de instalaciones @instalaciones @humo | lectura |
| `a5f8fc2b-af9c-4c6c-8768-823a8e87f1c3` | `tests/arranque/arranque.spec.ts` | C900004 Arrancar la raíz y esperar current dentro del timeout del frontend @arranque @humo | lectura |
| `08da2055-0aa2-4fb5-8240-0b52558d806f` | `tests/rendimiento/dxmon.spec.ts` | C900005 Medir ciclo DXMon de raíz, pantallas y GET aprendidos @rendimiento | lectura |

**Los IDs `C900001`–`C900005` son PLACEHOLDERS** (rango reservado `C900000–C900999`). Deben sustituirse por los IDs
reales confirmados en Bloque 0, en el título del test y en `cases` del manifiesto, en el mismo PR. El validador los
reporta como bloqueo de aprobación (`caso_placeholder`) y `--cases` detecta casos inexistentes (`caso_inventado`).

## Convenciones (ESP §10) y cómo se cumplen

1. **Título con ID y etiquetas**: `C1234 Descripción @etiqueta …`. El validador exige que IDs y etiquetas del título
   coincidan con el manifiesto.
2. **Selectores**: `getByTestId` → `getByRole` → `getByLabel` → `getByText`; sin clases generadas ni XPath. Solo los
   Page Objects tienen selectores. Las clases públicas de MUI/Inovua son excepciones versionadas
   (`pages/selectores-excepciones.md`, `SELECTOR_EXCEPTIONS_VERSION`).
3. **Esperas por condición**: `expect(...)`, `waitForResponse` (helper `waitForService`). `waitForTimeout` prohibido
   salvo `tests/rendimiento/` y `tools/` (el validador lo verifica).
4. **Una verificación por paso relevante**: cada `test.step` verifica HTTP del servicio de ESP §2 y estado visible.
5. **Sesión por storageState** de `auth.setup.ts`; ningún test escribe credenciales.
6. **Datos `@escritura`**: prefijo `QA-AUTO-<runId>-<worker>-<uuid>` (`fixtures/data.ts`).
7. **Grillas Inovua**: `waitForInovuaGridReady(locator)` — sin `.MuiSkeleton-root`, `.MuiCircularProgress-root` ni
   `.InovuaReactDataGrid__load-mask--visible` visibles; filas `.InovuaReactDataGrid__row` o estado vacío.
8. **Pedido al frontend**: lista de `data-testid` solicitados en `pages/selectores-excepciones.md`.
9. **Manifiesto autoritativo** `katalyst.manifest.json` con UUID v4 estable; además cada test declara la anotación
   `katalyst.stableKey` (el validador comprueba que coincidan, lo que detecta renombres sin actualizar manifiesto).
10. **Datos y aislamiento**: fixtures tipadas (`fixtures/test.ts`: `katalystEnv`, `fixtureProfile`, `parameterKey`
    = `default`), cleanup en `finally` limitado al prefijo propio (`withTestData`), tests de escritura bloqueados en
    producción y sin reintentos salvo idempotencia aprobada (`configureWriteSuite`).
11. **Verificaciones**: una grilla vacía puede ser correcta: el perfil de fixture (`KATALYST_FIXTURE_PROFILE`) define
    `con_filas`, `vacia` o `con_filas_o_vacia` por pantalla. `TODO selector`, skips no autorizados, `.only` y
    ausencia de clasificación impiden aprobar.
12. **Selectores compartidos**: Page Objects; excepciones controladas sin eliminación automática.

Clasificación: `lectura | escritura | sin_clasificar`. `@escritura` es **derivada** de la clasificación (el validador
la exige si y solo si `classification = escritura`). Un test que mezcla lectura y escritura se clasifica escritura.

Skips autorizados: toda llamada `test.skip/fixme` en `tests/` debe ir precedida por
`// katalyst-skip-autorizado: <motivo>` y estar documentada. Único caso actual: `dxmon_no_disponible`.

## Variables de entorno

Ver `.env.example`. Ninguna contiene secretos.

| Variable | Uso | Default |
| --- | --- | --- |
| `KATALYST_ENV_NAME` | Nombre del project/ambiente | `sin-ambiente` (solo para listar) |
| `KATALYST_APP_URL` / `KATALYST_API_URL` | URLs del ambiente (https; sin credenciales/query) | — (obligatorias al ejecutar) |
| `KATALYST_ENV_IS_PRODUCTION` | `false` explícito para no producción | producción (fail-safe); `cbc.deltax.la`/`fmsapi.deltax.la` siempre producción |
| `KATALYST_ENVIRONMENT_ID` | UUID del ambiente en Katalyst (perf) | `null` |
| `KATALYST_RUN_ID` | ID de corrida ([A-Za-z0-9_-]) | `local-<epoch>` |
| `KATALYST_STORAGE_STATE_PATH` | storageState temporal, **fuera del repo** | `$TMPDIR/katalyst-qa-tests-<uid>/<env>.storageState.json` |
| `KATALYST_TEST_USER_FILE` | JSON `{"username": "...", "password": "..."}` montado en tmpfs, fuera del repo | — |
| `KATALYST_EXPECTED_USERNAME` | Identidad esperada tras login (RF-AMB-03) | username del archivo |
| `KATALYST_FIXTURE_PROFILE` | `default` \| `staging-sembrado` | `default` |
| `KATALYST_RETRIES` | 0..2 | 0 |
| `KATALYST_WORKERS` | 1..8 | 1 |
| `KATALYST_ARTIFACT_POLICY` | JSON `{trace, video, screenshot, sanitizationVerified}` | prod: todo `off`; no prod: trace/video `off`, screenshot `only-on-failure` |
| `KATALYST_OUTPUT_DIR` | outputDir de Playwright | `test-results` |
| `KATALYST_REPORT_HTML_DIR` / `_JSON_FILE` / `_JUNIT_FILE` | Rutas de reportes | `playwright-report/{html,results.json,junit.xml}` |
| `KATALYST_PERF_*`, `KATALYST_DXMON_CYCLE_MS`, `KATALYST_WORKER_PROFILE` | Rendimiento (ver `tools/README-dxmon.md`) | ver archivo |

En producción, trace/video/screenshot distintos de `off` exigen `sanitizationVerified: true` (lo declara el backend
tras el ensayo con canarios, ESP §13.7); si no, la configuración falla con `politica_artefactos_insegura`. El project
`setup` nunca genera trazas, video ni capturas (la acción `fill` de la contraseña quedaría registrada).

## Correr localmente

```bash
pnpm install                      # desde la raíz del monorepo (o npm/pnpm dentro de qa-tests)
pnpm --filter qa-tests typecheck
pnpm --filter qa-tests list       # lista setup + 5 tests sin necesitar ambiente
pnpm --filter qa-tests validate:manifest
```

Ejecutar contra **staging** (nunca contra producción sin autorización operativa, ESP §14):

```bash
pnpm exec playwright install chromium   # solo en máquinas de desarrollo; el worker usa la imagen oficial
mkdir -p /tmp/katalyst && chmod 700 /tmp/katalyst
# Crear /tmp/katalyst/test-user.json (0600) con {"username":"<usuario-de-prueba>","password":"<contraseña>"}
export KATALYST_ENV_NAME=staging KATALYST_ENV_IS_PRODUCTION=false \
       KATALYST_APP_URL=https://<staging-app> KATALYST_API_URL=https://<staging-api> \
       KATALYST_TEST_USER_FILE=/tmp/katalyst/test-user.json \
       KATALYST_STORAGE_STATE_PATH=/tmp/katalyst/storageState.json
pnpm --filter qa-tests test:humo
```

## Ejecución desde el runner de Katalyst

1. El supervisor recibe el lease de un shard (`assignment`: commit, `manifestHash`, tests por `stableKey`,
   ambiente, `testUserRef`, timeouts, `artifactPolicy`). Revalida el hash del manifiesto canónico (SHA-256 de JSON con
   claves ordenadas; lo imprime `validate-manifest`) y el commit (ESP §13.1).
2. Monta el secreto del usuario de prueba como archivo en tmpfs (`KATALYST_TEST_USER_FILE`) y un directorio tmpfs para
   `KATALYST_STORAGE_STATE_PATH`; nunca pasa secretos por argumentos ni variables con el valor (ESP §13.7).
3. Lanza el ejecutor en la imagen `mcr.microsoft.com/playwright:v1.65.0-noble@sha256:…` con las variables
   `KATALYST_*` y `playwright test --project=<env> <archivos>` (el project `setup` corre como dependencia),
   filtrando por los tests asignados (`--grep` del título o lista de archivos; la identidad es el `stableKey`).
4. Lee `KATALYST_REPORT_JSON_FILE` (resultados por intento, anotaciones `katalyst.stableKey`, `katalyst.metric`,
   skips con motivo) y, para `@rendimiento`, `samples.json`/`summary.json`; sanitiza y sube artefactos permitidos.
5. Clasifica fallas por el prefijo `[codigo]` del mensaje (`fixtures/errors.ts`): p. ej. `auth_desafio_mfa`,
   `auth_credenciales_invalidas`, `auth_identidad_inesperada`, `auth_ambiente_inesperado`, `dxmon_no_versionado`.
   Una falla del project `setup` se informa como falla de login separada de las pantallas no ejecutadas (ESP §13.2).
6. `global-teardown.ts` borra el storageState; el supervisor además desmonta el tmpfs y limpia huérfanos tras un
   crash.

El listado del catálogo (`POST /tests/refresh`) ejecuta `playwright test --list --reporter=json` en un contenedor
aislado sin secretos (ESP §4). El project `setup` se excluye del catálogo.

## Validación del manifiesto

`node scripts/validate-manifest.ts [--strict] [--list-file <json>] [--cases <json>] [--json]` verifica:

- esquema del manifiesto (claves, UUID v4 únicos en minúsculas, `C\d+`, etiquetas `@…`, clasificación válida,
  `parameterKeys`, `writeIdempotencyApproved`, `owner`);
- correspondencia exacta con `playwright test --list --reporter=json` (sin tests fuera del manifiesto ni entradas sin
  test; anotación `katalyst.stableKey` coherente; etiquetas listadas = manifiesto);
- IDs y etiquetas del título = manifiesto; `@escritura` derivada de la clasificación; `@rendimiento` solo lectura;
- casos inventados respecto a una lista opcional de TestRail (`--cases`);
- sin `.only`, sin `waitForTimeout` fuera de rendimiento, skips solo con marcador autorizado;
- `TODO selector` en el test o en cualquier archivo que importe (transitivo) y en el login → **bloqueo de
  aprobación**; IDs placeholder y `sin_clasificar` también;
- escaneo simple de secretos (AWS keys, claves privadas, JWT, Bearer literales, credenciales literales,
  storageState versionado). Complementa a `gitleaks`, no lo reemplaza.

Sin `--strict` los bloqueos de aprobación se informan pero no fallan; con `--strict` (check obligatorio de merge
protegido) fallan con código 2. **Validación local**: en la integración del monorepo se reemplazará por el validador
compartido de `@katalyst/shared/manifest` (mismo contrato, plan §4.1/§4.2).

## Regla de aprobación por PR (ESP §13.1, RF-GRB-05)

- Aprobar un test = **PR/MR con revisión de un desarrollador, checks obligatorios en verde y merge a la rama
  protegida**. Un `status=aprobado` en la base de datos no aprueba código por sí solo; el catálogo solo incorpora el
  commit fusionado.
- Checks obligatorios: `validar` (typecheck, `validate-manifest`, `playwright test --list`),
  `bloqueos-aprobacion` (`validate-manifest --strict`) y `gitleaks`. Configurar protección de rama: sin push directo,
  revisión requerida (CODEOWNERS de desarrolladores), checks requeridos, sin bypass.
- La cuenta de servicio que abre PRs de grabación (RF-GRB-02) **no** puede saltarse la protección ni fusionar
  automáticamente.
- Todo cambio de título/archivo de un test actualiza el manifiesto en el mismo PR (el `stableKey` no cambia).
- Mientras existan los bloqueos de Bloque 0 de abajo, `bloqueos-aprobacion` falla **intencionalmente**: los tests son
  ejecutables en staging para validar, pero no aprobables.

## Bloqueos de Bloque 0 (ESP §11)

| Bloqueo | Estado | Qué falta |
| --- | --- | --- |
| IDs reales de TestRail de los 4 casos iniciales (+ caso dedicado `@rendimiento`) | Pendiente | Reemplazar `C900001..C900005` en títulos y manifiesto; confirmar resultados esperados y fixtures por caso |
| Selectores del login Cognito | Pendiente | `pages/LoginPage.ts` usa `getByLabel`/`getByRole` supuestos marcados `TODO selector (Bloque 0)`; confirmar si es formulario propio (Amplify) o Hosted UI |
| MFA / desafíos de Cognito | Pendiente | Si el usuario de prueba tiene MFA o cambio de contraseña obligatorio, el setup falla con `auth_desafio_mfa` (incompatible con ejecución desatendida). Se necesita usuario dedicado sin MFA interactivo o acuerdo explícito (ESP §12) |
| Esquema de `users/api/users/current` | Pendiente | Campo que identifica al usuario (hoy se buscan `username/email/…`; si no existe, `auth_identidad_no_verificable`) |
| Expiración/renovación de sesión Cognito | Pendiente | Medir duración del idToken frente al timeout de corrida (20 min) y si el storageState basta o hay que renovar |
| Selectores de pantallas | Pendiente | Encabezados, pestañas, botones lista/calendario, navegación (`TODO selector`); pedir `data-testid` (regla 8) |
| Rutas/métodos exactos de servicios | Pendiente | `place`, `.../filter` (query o cuerpo para `typeOperation`), que `/` redirija a `/controlCenterShipper` |
| Estado vacío de Inovua (E-04) | Pendiente | Confirmar `.InovuaReactDataGrid__empty-wrapper` |
| DXMon (`deltax_monitor.js`, `run_dxmon.js`, muestras) | **Bloqueo de 2B** | Ver `tools/README-dxmon.md`; el test `@rendimiento` se omite con `dxmon_no_disponible` |
| Allowlist de GET repetibles | Pendiente | Todas las entradas de `tools/dxmon-allowlist.json` están `approved: false` |
| Ambiente de staging y usuario de prueba | Pendiente (ESP §12) | Sin staging no se valida login ni escritura; producción solo lectura aprobada |

Nada de este repositorio se ha ejecutado contra `cbc.deltax.la` (producción; no autorizado).
