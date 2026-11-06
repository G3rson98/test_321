# DXMon en qa-tests — adaptador, contrato y bloqueo

Requisitos: RF-REN-01, RF-REN-05; ESP §2 (DXMon v3, hallazgos), §7 (`perf_sample`), §10 (`tools/deltax_monitor.js`
sin modificar su lógica), §13.7 (allowlist de GET) y §13.8 (contrato de medición).

## 1. Bloqueo vigente: los scripts legados no están disponibles

ESP §2 ("Dependencia por verificar") indica que `deltax_monitor.js` (DXMon v3) y `run_dxmon.js` se describen como
existentes pero **no estaban en la carpeta revisada**. Mientras no se reciban:

- `tests/rendimiento/dxmon.spec.ts` se marca `test.skip` con motivo explícito
  **`dxmon_no_disponible`**. Es un *skip autorizado y documentado* (marcador `// katalyst-skip-autorizado:` que
  reconoce `scripts/validate-manifest.ts`), no un test oculto: el reporte JSON de Playwright muestra la anotación
  `skip` con el motivo y el runner lo publica como omitido con causa.
- El criterio de Bloque 0 "Recibidos o identificados como bloqueo de bloque 2B los scripts DXMon y muestras
  sanitizadas" queda **identificado como bloqueo de 2B**.

Para levantar el bloqueo (PR revisado por desarrollador, ESP §13.1):

1. Copiar `deltax_monitor.js` **sin cambios** en `tools/deltax_monitor.js`.
2. Completar `tools/dxmon-legacy.lock.json`: `sha256` (de `shasum -a 256 tools/deltax_monitor.js`), `dxmonVersion`,
   `source`, `usageTerms`, `receivedAt`. El adaptador rechaza un script sin hash (`dxmon_no_versionado`) o con hash
   distinto (`dxmon_hash_no_coincide`).
3. Adjuntar muestras anonimizadas de `samples.json` y `summary.json` del legado y ajustar el mapeo marcado
   `TODO(Bloque 2B)` en `tools/dxmon-adapter.ts` (`normalizeDxmonSamples`, firmas de `DXMon.start/samples/isRunning`,
   bandera de fin de ciclo).
4. Revisar y aprobar entradas de `tools/dxmon-allowlist.json` (`approved: true`, `reviewedBy`, `reviewedAt`).
5. Crear el caso dedicado en TestRail para `@rendimiento` (ESP §13.1) y reemplazar el placeholder `C900005`.

`run_dxmon.js` **no se reutiliza**: su perfil persistente de Chrome está prohibido (ESP §13.7). Su función
(inyectar, reinyectar tras recarga, guardar `summary.json`/`samples.json`) la cumple este adaptador con el
`storageState` aislado del ejecutor.

## 2. Funcionamiento del adaptador (`tools/dxmon-adapter.ts`)

- **Inyección sin modificar la lógica:** `context.addInitScript({ content })` con el texto exacto del archivo (se
  aplica a cada documento nuevo). Tras cada `load`, si `window.DXMon` no existe se **reinyecta** con
  `page.addScriptTag`. Si DXMon estaba corriendo y expone `isRunning()` y devuelve `false`, se vuelve a llamar
  `start(opts)`; si no expone `isRunning`, no se reinicia a ciegas (evita duplicar mediciones) y se cuenta en
  `summary.json → dxmon.reloads_without_restart`.
- **API usada:** `DXMon.start(opts)`, `DXMon.mark(label)`, `DXMon.summary()`, `DXMon.stop()`; opcionales
  `DXMon.samples()` e `isRunning()`. Si faltan las cuatro obligatorias: `dxmon_api_incompatible`.
- **Allowlist (ESP §13.7):** solo las entradas `approved: true` de `tools/dxmon-allowlist.json` se entregan a
  `DXMon.start({ allowlist })`. Hoy **ninguna está aprobada** (pendiente de revisión): DXMon no debe repetir ningún
  GET. Toda muestra `probe` fuera de la allowlist aprobada se marca `invalid_reason = endpoint_no_permitido` y el
  test falla con `dxmon_endpoint_no_permitido` (después de escribir las salidas). `dashboard/powerBi/token` está
  denegado siempre (emite un token).
- **Ciclo ≤ 4 min (ESP §13.3/§13.8):** presupuesto `KATALYST_PERF_CYCLE_BUDGET_MS` (default 200 000 ms, máx. 210 000),
  fase DXMon `KATALYST_DXMON_CYCLE_MS` (default 90 000 ms), reserva de 15 s para escribir salidas. El test tiene
  timeout = presupuesto + 30 s (≤ 240 s). Si el ciclo excede 4 min: `rendimiento_ciclo_excedido`. Las pantallas que
  no caben en el presupuesto se omiten (anotación `pantallas_omitidas_por_presupuesto`); nunca se recortan sus
  límites para "caber".
- `waitForTimeout` se usa solo aquí (espera del ciclo DXMon), excepción permitida por ESP §10 regla 3.

## 3. Fases y procedencia (no mezclar series)

| Fase | Procedencia (`provenance`) | Qué mide | `source` | `metric_kind` |
| --- | --- | --- | --- | --- |
| 1a. Raíz caché fría (contexto nuevo) | `playwright` | navegación `/` → app utilizable | `raiz` | `root_ready` |
| 1a. idem | `playwright` | navegación `/` → fin de respuesta de `current` | `raiz` | `root_current_wait` |
| 1b. Raíz caché caliente (mismo contexto) | `playwright` | idem 1a | `raiz` | `root_ready`, `root_current_wait` |
| 1c. Pantallas (caché caliente) | `playwright` | acción/navegación → grilla lista o estado vacío | `ui` | `screen_ready` |
| 1a–1c. Llamadas de la app | `playwright` | petición fetch/xhr del frame principal al origen de la API | `app` | `network_request` |
| 2. Ciclo DXMon | `dxmon` | lo que DXMon v3 reporte (pantallas, raíz en iframe, GET repetidos) | `ui` / `raiz` / `probe` / `app` | según `source` |

El observador Playwright **se pausa durante la fase 2** e ignora peticiones de iframes, de modo que los GET repetidos
por DXMon nunca se cuentan como llamadas de la app (ESP §13.8). Las series se separan por
`(provenance, source, metric_kind, endpoint_key | screen_key, cache_mode, worker_profile)` y, en el backend, además por
ambiente. **Pendiente de integración:** `provenance` es una extensión propuesta al contrato de `@katalyst/shared/perf`
y al `series_selector` de `perf_threshold`.

## 4. Fronteras de medición

- **`network_request`** — desde `request.timing().startTime` (epoch ms, CDP) hasta `responseEnd` (ms relativos a
  `startTime`), o hasta el corte. `ttfb_ms` = `startTime → responseStart`; `download_ms` = `responseStart →
  responseEnd`. Los tiempos de CDP no dependen de `Timing-Allow-Origin`; no se modifica TAO del sistema bajo prueba.
  Unidades validadas: número finito, ≥ 0, < 10 min y no mayor que el reloj de pared del proceso de test + 1,5 s
  (`invalid_reason = unidad_incoherente`). `-1` de CDP ⇒ `null` con `null_reasons.<campo> = timing_no_disponible`.
- **`screen_ready`** — desde la acción/navegación hasta que la grilla Inovua está lista según ESP §10 regla 7 (o el
  estado vacío esperado). Resultado por condición lista/fallida, no por HTTP.
- **`root_ready`** — desde `page.goto('/')` hasta la condición de app utilizable de `ControlCenterPage.expectUsable()`.
- **`root_current_wait`** — desde `page.goto('/')` hasta `responseEnd` de `users/api/users/current`. Submétrica del
  arranque: no prueba que la pantalla esté lista.

Timeouts como observación censurada: `total_ms = null`, `timeout = censored = true`, `censored_at_ms` = duración hasta
el corte, `timeout_limit_ms` = límite (30 000 `current`, 20 000 filtros, o el límite de condición de pantalla). Un
aborto antes del límite (navegación) es `invalid_reason = abortada`, no timeout. `over_29s` solo para respuestas
completadas con duración estrictamente > 29 000 ms.

Tamaños: `bytes_wire` = cabeceras + cuerpo codificado recibidos (CDP `request.sizes()`); `bytes_body` = longitud del
cuerpo descomprimido (se mide la longitud; **el cuerpo nunca se persiste**). En muestras DXMon, un `0` de Resource
Timing sin TAO se guarda `null` con `cero_no_confiable_sin_timing_allow_origin` (no se infiere compresión de un cero).

Calidad: `visible` = `document.visibilityState === 'visible'` al iniciar la medición (`false` ⇒
`invalid_reason = pagina_no_visible`); carga media de 1 min por CPU > `KATALYST_PERF_MAX_LOAD_PER_CPU` (default 1,5)
⇒ `invalid_reason = contencion_worker`. Los recursos del worker al inicio/fin quedan en `summary.json`.

## 5. Archivos de salida (contrato de importación, `schema_version` 1)

Se escriben en `KATALYST_PERF_OUTPUT_DIR` (default `<outputDir del test>/dxmon/`), con permisos 0600, y se adjuntan
al resultado del test.

`samples.json`:

```json
{
  "schema_version": 1,
  "kind": "katalyst.perf_samples",
  "run_id": "…", "environment_id": null, "environment_name": "staging",
  "generated_at": "2026-11-06T15:00:00.000Z",
  "worker_profile": "linux-x64-2cpu-8gib-pw1.65.0",
  "producer": { "adapter": "katalyst-dxmon-adapter", "adapter_version": "0.1.0", "playwright_version": "1.65.0",
                "browser_version": "…", "dxmon": { "available": true, "version": "3.x", "sha256": "…" } },
  "samples": [
    {
      "run_id": "…", "ts": "2026-11-06T15:00:01.234Z", "source": "app",
      "endpoint": "api:/travelUploader/api/travelUploader/cbc/loadingOrder?typeOperation=distribution",
      "status_code": 200, "ok": true, "total_ms": 812.4, "ttfb_ms": 640.1, "download_ms": 172.3,
      "bytes_wire": 151234, "bytes_body": 1203311, "timeout": false, "over_29s": false, "visible": true,
      "environment_id": null, "sample_key": "<sha256(run_id|provenance|seq)[0..32]>", "schema_version": 1,
      "endpoint_key": "GET /travelUploader/api/travelUploader/cbc/loadingOrder?typeOperation=distribution",
      "screen_key": "loadOrder:distribution", "metric_kind": "network_request", "cache_mode": "caliente",
      "worker_profile": "…", "censored": false, "invalid_reason": null,
      "provenance": "playwright", "method": "GET", "error_kind": null, "censored_at_ms": null,
      "timeout_limit_ms": null, "content_encoding": "gzip", "null_reasons": {}
    }
  ],
  "quarantine": [ { "index": 3, "provenance": "dxmon", "reason": "source_desconocido" } ]
}
```

`summary.json` (informativo; el backend recalcula desde muestras crudas): `run_id`, `started_at`, `finished_at`,
`duration_ms`, `cycle_budget_ms`, `cycle_limit_ms` (240 000), `worker` (perfil y recursos inicio/fin), `producer`,
`dxmon` (`reinjections`, `restarts`, `reloads_without_restart`, `raw_summary_keys` — solo nombres de claves del
resumen crudo, nunca su contenido —, `not_allowlisted`), `skipped_screens`, `counts` y `series[]` con
`n_started_valid`, `n_completed`, `n_success`, `n_errors`, `n_timeouts`, `n_over_29s`, `n_invalid`, `mean_ms`,
`max_ms`, `p95_ms` (rango `ceil(0,95·n)` base 1, solo con ≥ 20 completadas; si no, `null` y
`p95_status = muestra_insuficiente`), `error_rate` y `timeout_rate` (solo con ≥ 20 solicitudes válidas iniciadas).

Normalización de endpoints: segmentos con forma de ID (numéricos, UUID, hex largos, opacos ≥ 24, correos) → `:id`;
de la query solo se conserva `typeOperation`; el origen se reemplaza por `api` / `app` / `externo`. Sin datos
personales ni URLs crudas.

Deduplicación en importación: `(run_id, sample_key)`; `sample_key` es determinista por archivo.
