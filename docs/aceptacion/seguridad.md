# Aceptación — seguridad: secretos en el repositorio y ensayo de canarios

Fecha: 2026-11-06 · Requisitos: RNF-SEG-01, RNF-SEG-02, ESP §13.7, criterio de Bloque 1 «Ningún secreto aparece en
el repositorio, los logs ni los reportes (revisión con `gitleaks` o similar)».

## 1. gitleaks (repositorio e historial)

Herramienta: gitleaks 8.30.1 (`brew install gitleaks`), configuración [`.gitleaks.toml`](../../.gitleaks.toml)
(reglas por defecto + canario `KATALYST_CANARY_*`, valores literales `KATALYST_SECRET__*`, API key de TestRail,
`storageState`, tokens Cognito y contraseñas literales).

| Escaneo | Comando | Resultado |
| --- | --- | --- |
| Árbol de trabajo, primera pasada | `pnpm secrets:scan` | 43 hallazgos en 26 pares archivo/regla — **todos falsos positivos** (ver abajo) |
| Árbol de trabajo, con excepciones acotadas | `pnpm secrets:scan` | **0 hallazgos** (~4,7 MB) |
| Historial git (2 commits) | `pnpm secrets:scan:git` (`gitleaks git --config .gitleaks.toml --redact .`) | **0 hallazgos** (~4,5 MB) |

Clasificación de los 43 hallazgos iniciales (revisados uno a uno):
- **Canarios y credenciales sintéticas de pruebas** (`apps/api/test`, `apps/runner/test`, `apps/recorder/test`):
  canarios con el prefijo `KATALYST_CANARY_*`, contraseñas de prueba asignadas literalmente (`password: …`), JWT de ejemplo, `token=abc123…` en pruebas de
  sanitización/autenticación. Son valores inventados que las pruebas siembran a propósito (ESP §13.7).
- **`stableKey` del manifiesto** (`qa-tests/katalyst.manifest.json`, manifiesto local de la fixture): UUID v4 que la
  regla genérica `generic-api-key` confunde con una clave.
- **Contraseña de demostración del mock MSW del panel** (`apps/web/src/mocks/fixtures.ts`, `katalyst-demo`): solo
  existe en el modo demo sin backend.

Excepciones añadidas (`[[allowlists]]` con `targetRules`, no globales): rutas `^apps/(api|runner|recorder)/test/` solo
para `katalyst-canary|password-assignment|generic-api-key|jwt`; regex de `stableKey` UUID solo para
`generic-api-key`; `^apps/web/src/mocks/` solo para `password-assignment`. El bloque `[allowlist]` previo se
convirtió a `[[allowlists]]` (gitleaks ≥ 8.25 no admite ambos). Un secreto real en código de producción, en
`scripts/`, en `deploy/` o en la documentación sigue detectándose.

## 2. Ensayo de canarios (ESP §13.7)

Comando: `FAKE_DELTAX_CANARIES='<json>' pnpm accept:canarios < admin.pass` (script
[`scripts/aceptacion-canarios.ts`](../../scripts/aceptacion-canarios.ts)) sobre el stack local
([`e2e-local.md`](e2e-local.md)), con la fixture `fake-deltax` arrancada con cuatro canarios aleatorios por ensayo:

| Canario | Forma | Dónde lo expone la fixture |
| --- | --- | --- |
| token | `KATALYST_CANARY_*` (TOKEN + hex aleatorio) | DOM, `value` de un `<input>`, **query de la URL** (`/canario?token=…`), `localStorage`, `Authorization: Bearer` de un `fetch`, cuerpo JSON (`accessToken`), consola |
| cookie | `KATALYST_CANARY_*` (COOKIE + hex aleatorio) | `Set-Cookie: fx_canary=…` en el login (llega a `storageState`, trazas y red) |
| dato personal | `maria.canario.<hex>@cliente-canario.test` | DOM, cuerpo JSON (`cliente.documento`), consola |
| secreto | `KATALYST_CANARY_*` (SECRET + hex aleatorio) | DOM, cuerpo JSON (`clave`), encabezado `x-katalyst-canary`, consola |

Además se buscan las credenciales de desarrollo del stack: contraseña del usuario de prueba, API key de TestRail,
token `ksv_` del supervisor y secreto de sesión. El test **C900009** lee los valores, los imprime con
`console.log` y **falla con un mensaje que contiene token, secreto y dato personal**. Ambiente `canario-local` con
política de evidencia amplia: `reporte`, `log`, **`traza`** y **`captura`** (habilitadas a propósito para el ensayo).
Corridas: C900009 + C900006 con `testrail.mode = nueva` (publica resultados y la captura de la falla).

Cada valor se busca en texto plano, URL-encoded y base64 (las tres alineaciones), más el patrón genérico
`KATALYST_CANARY_*`, en:

| Ubicación | Qué se inspeccionó | Hallazgos |
| --- | --- | --- |
| BD completa | `pg_dump --data-only` de `katalyst_accept` (run_result, test_attempt, artifact, outbox_delivery con payloads, event_log, audit_log, case_result, run…) | **0** |
| Logs de procesos | `api.log`, `control.log`, `reports.log`, `supervisor.log` (incluye los logs reenviados de cada ejecutor), `migrate.log`, `bootstrap.log` | **0** |
| Almacén de artefactos | todos los archivos de la corrida en el almacén `fs`: reporte JSON, reporte HTML (+ blobs `data:…;base64` decodificados, ZIP internos descomprimidos), logs, traza ZIP descomprimida (`*.trace`, `*.network`, `resources/*`, `src/*`), captura PNG (cadenas imprimibles) | **0** |
| Descargas por la API | cada artefacto `sanitizado` descargado por su URL firmada (`GET /runs/:id/artifacts/:aid`) | **0** |
| TestRail (falso) | runs, tests y resultados (`comment`) recibidos + adjuntos subidos (PNG) | **0** |
| Respuestas de la API | `GET /runs/:id`, `/results`, `/results/:rid/attempts`, `/case-results`, `/targets`, `/artifacts`, `/audit-log`, `/integrations/testrail/deliveries`, y 4 s del SSE `/runs/:id/events` | **0** |
| Restos del runner | `runner/shards/*` (secretos montados, `storageState`) y `runner/data/runs/*` tras terminar | **0 archivos** |

Lo que se ve en su lugar (ejemplo real del error persistido del intento):
`Error: valor sensible [REDACTED:canary] token [REDACTED:canary] documento [REDACTED:email] … Received: "[REDACTED:canary]"`.
Los 6 artefactos de la corrida quedaron `sanitizado`; la publicación en TestRail quedó `sincronizada`.

### 2.1 Hallazgos y correcciones

1. **Píxeles en trazas (corregido, D-053).** La traza ZIP pasaba la verificación textual pero contenía
   fotogramas `screencast/*.jpeg` de la página completa, con los canarios **visibles**. El ejecutor ahora elimina
   esos fotogramas al sanitizar cualquier ZIP (`apps/runner/src/executor/artifacts/sanitize-artifact.ts`,
   `SCREENCAST_FRAME_RE`); la traza conserva red, DOM y pasos ya sanitizados y el visor funciona sin la tira de
   imágenes. Prueba: `apps/runner/test/acceptance/trace-pixels.test.ts`. Re-ensayo: ver §2.2.
2. **Capturas (`captura`) — riesgo abierto, sin cambio de código.** La captura PNG de la falla muestra los
   canarios en píxeles y, con `captura` habilitada en la política del ambiente, se sube al almacén y a TestRail
   (estado `sanitizado` significa «sin datos sensibles en metadatos», no enmascaramiento visual). No existe hoy
   enmascaramiento visual (p. ej. `mask` de Playwright sobre selectores sensibles). Mitigación vigente: la política
   por defecto **deshabilita** `captura`, `traza` y `video` en todos los ambientes con el motivo visible
   (`DEFAULT_STAGING_ARTIFACT_POLICY`); producción además prohíbe `traza` y `video`. **Recomendación:** no habilitar
   `captura` fuera de ambientes con datos sintéticos hasta implementar y ensayar el enmascaramiento visual, como
   exige ESP §13.7 y el criterio de Bloque 1 «captura sanitizada en fallas en el ambiente de prueba que la permite».
3. **Falso bloqueo del verificador (corregido, D-053)**, detectado en el ensayo extremo a extremo: el código fuente
   incrustado por Playwright en `error-context.md` (``?token=${…}``) quedaba como `?token=[REDACTED:…]}` y el
   verificador lo contaba como residual, bloqueando el log y el reporte HTML completos. Era un fallo seguro
   (fail-closed) pero ocultaba evidencia válida. `packages/shared/src/sanitize/verify.ts` + prueba de regresión.

### 2.2 Re-ensayo tras las correcciones

Tres corridas de canarios en total (5f1fa9dd, fec151f3 antes de la corrección de trazas; 3a73ad80 después). En la
última: 6 artefactos `sanitizado` (captura, 2 logs, traza, reporte JSON, reporte HTML), publicación TestRail
`sincronizada` con la captura adjunta, **0 hallazgos** en BD, logs, almacén (24 archivos/entradas), descargas (24),
TestRail (4) y API (10 respuestas + SSE), 0 restos en el runner, y la traza ZIP ya **sin entradas `screencast/`**
(antes 4 fotogramas). Las capturas PNG siguen mostrando los canarios en píxeles (riesgo 2.1-2).

## 3. Qué queda sin verificar
- Video (`video`) y capturas con enmascaramiento visual: no implementado (ver 2.1-2).
- Launcher `docker` (aislamiento de red/secretos del contenedor ejecutor, sin socket Docker ni metadatos de nube):
  requiere un host con Docker; la configuración está en `deploy/docker-compose.yml` (`x-katalyst-executor`).
- Almacén S3 real y TestRail real (Bloque 0): el ensayo usa el almacén `fs` y el TestRail falso; el contenido
  sanitizado que se sube es el mismo.
- Logs de Caddy y del host en producción (fuera del alcance local).
