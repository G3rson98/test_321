# Aceptación — rendimiento del panel/API (RNF-REN-01, RNF-OPT-05, ESP §17.4–17.5)

Fecha: 2026-11-06 · Criterio: con 5.000 casos y 10 usuarios concurrentes, **p95 de las API de listado < 1 s** en un
ensayo de 5 min, páginas de hasta 100 filas, registrando recursos y plan; consultas sin N+1 y pool total ≤ 20.

## 1. Plan del ensayo

| Elemento | Valor |
| --- | --- |
| Equipo | Apple M1 Pro, 8 núcleos, 16 GiB RAM, macOS 26 (darwin 25.6.0), Node 24.22.2, PostgreSQL 16.15 y Redis locales (sin red externa) |
| Procesos | stack local (`scripts/dev-stack.sh`): api (pool 10), control (6), reports (3), supervisor; `RATE_LIMIT_MAX=100000` solo para el ensayo (los 10 usuarios comparten la IP de loopback; el límite por cliente de producción es 300/min) |
| Datos (`pnpm load:seed`) | 5.609 casos TestRail (5.000 de la suite de carga en 10 áreas × 5 secciones, árbol de 2 niveles), 5.009 tests automatizados vinculados 1:1, 300 corridas históricas (30 días) con 7.500 resultados, 6.750 intentos y 7.500 resultados por caso, 123 programaciones, 20.042 registros de auditoría. Tamaños: `testrail_case` 13 MB, `automated_test` 8 MB, `audit_log` 8 MB |
| Carga (`pnpm load:run -- --duration 300`) | 10 usuarios = 10 sesiones de panel independientes (cookie), **lazo cerrado sin tiempo de reflexión** (peor caso: cada usuario lanza la siguiente solicitud apenas recibe la anterior), cliente `fetch` de Node (undici) |
| Escenarios (peso) | casos: lista (3), búsqueda `q` (3), suite + automatizados (2), sección con descendientes (2), último resultado `fallido` (1), página profunda por cursor 2–11 (2); tests: lista (2), búsqueda + etiqueta (2), estado + orden (1); corridas: lista (2), estado + ambiente (1); programaciones (1); auditoría: lista (1) y página profunda (1). Todas con `limit=100` |
| Mediciones | latencia por solicitud (p50/p95/p99/máx por endpoint y global), códigos HTTP, CPU/RAM del equipo (`os`, cada 5 s), CPU/RSS de api/control/reports/supervisor/postgres (`ps`), conexiones PostgreSQL abiertas a la BD (`pg_stat_activity`) |

## 2. Resultado del ensayo completo (5 min, 2026-11-06 22:56 UTC)

**67.188 solicitudes, 223,9 req/s, 100 % HTTP 200, p95 global 112,5 ms (p50 37,7, p99 163,9, máx 428,3 ms) ⇒ cumple
(< 1 s) con margen ~9×.** Conexiones PostgreSQL máx. **16** (≤ 20).

| Endpoint (limit=100) | n | p50 ms | p95 ms | p99 ms | máx ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/testrail/cases` lista | 8.402 | 47,0 | 139,7 | 191,8 | 312,4 |
| `/testrail/cases?q=` búsqueda | 8.398 | 38,9 | 115,1 | 158,1 | 259,7 |
| `/testrail/cases?suiteId=&automated=true` | 5.599 | 51,8 | 148,4 | 198,1 | 275,8 |
| `/testrail/cases?section=` (descendientes) | 5.601 | 45,4 | 134,2 | 171,3 | 428,3 |
| `/testrail/cases?lastResult=fallido` | 2.800 | 51,4 | 142,7 | 196,8 | 380,5 |
| `/testrail/cases?cursor=` (páginas 2–11) | 5.600 | 49,4 | 144,5 | 190,8 | 305,9 |
| `/tests` lista | 5.597 | 22,9 | 73,0 | 122,0 | 290,7 |
| `/tests?tag=@carga&q=` | 5.599 | 25,4 | 79,2 | 129,4 | 368,0 |
| `/tests?status=aprobado&sort=-updatedAt` | 2.799 | 19,4 | 67,2 | 117,8 | 171,1 |
| `/runs` lista | 5.598 | 29,7 | 80,0 | 127,9 | 220,4 |
| `/runs?status=terminada&environmentId=` | 2.798 | 29,6 | 80,3 | 126,9 | 205,1 |
| `/schedules` | 2.799 | 14,2 | 50,3 | 102,3 | 179,9 |
| `/audit-log` | 2.799 | 8,8 | 20,7 | 62,8 | 113,9 |
| `/audit-log?cursor=` (páginas 2–11) | 2.799 | 8,5 | 21,4 | 62,5 | 110,9 |

Recursos (máximos de las muestras cada 5 s): CPU del equipo prom. 82 % / máx. 98 %; `api` 215 % de CPU (≈ 2,2
núcleos) y 543 MiB RSS; PostgreSQL (todos los procesos) 423 % y 559 MiB; control 2 %, supervisor 5 %, reports 0 %.
El cuello de botella es CPU (API serializando JSON + PostgreSQL), no E/S. La carga del equipo fue más alta de lo
atribuible al ensayo porque otros procesos de desarrollo corrían en paralelo; el resultado es por tanto conservador.
Un ensayo previo de 30 s dio p95 68 ms (276 req/s). Datos crudos: `scripts/load/run-load.ts --out <archivo>`.

## 3. N+1 y planes (`pnpm load:explain`)

`scripts/load/explain-queries.ts` construye la API en proceso con un PrismaClient instrumentado, llama cada listado
con `limit=10` y `limit=100` y cuenta los SELECT de datos (sin autenticación); luego ejecuta
`EXPLAIN (ANALYZE, BUFFERS)` de cada consulta capturada.

| Endpoint | Consultas limit=10 → 100 | Σ ejecución SQL (limit=100) | Índices usados |
| --- | --- | ---: | --- |
| casos (lista/búsqueda/suite/sección/último resultado) | 5→5 / 5→5 / 5→5 / 6→6 / 6→6 | 5–29 ms | — (seq scan, ver abajo) |
| tests (lista / búsqueda+etiqueta) | 5→5 / 5→5 | 8–9 ms | `testrail_case_pkey` |
| corridas (lista / filtros) | 6→6 / 6→6 | 1,3–1,4 ms | `run_created_at_id_idx`, **`ix_run_environment_created_id`**, `run_result_run_id_status_idx` |
| programaciones | **12→101 (N+1) ⇒ corregido: 3→3** | 0,3 ms | índice único `(schedule_id, scheduled_for)` |
| auditoría | 2→2 | < 0,1 ms | **`ix_audit_log_created_at_id`** |

- **Bug corregido (D-053):** `GET /schedules` hacía una consulta de «última ocurrencia» por fila. Ahora una sola
  consulta `DISTINCT ON (schedule_id)`; prueba `apps/api/test/acceptance/schedules-list-batch.test.ts`.
- **Seq scans:** con ~5–6 mil filas por tabla (≤ 13 MB) PostgreSQL elige recorrido secuencial + top-N sort en los
  listados de casos/tests (≤ 25 ms por consulta). Los índices de §17.4 existen y el planificador los usa donde son
  selectivos (`run (environment_id, created_at, id)`, `audit_log (created_at, id)`, `run_result (run_id, …)`);
  `testrail_case (section_id, title, id)` y los GIN `pg_trgm` de título están creados (migración
  `catalog_title_trgm`) pero a este volumen no compensan. **Riesgo a vigilar:** el listado de casos ordenado por
  título sin filtro de sección no tiene índice `(title, id)`; con 10× más casos conviene medir y, si p95 crece,
  añadir `testrail_case (title, id) WHERE archived_at IS NULL`.
- **Pool:** api 10 + control 6 + reports 3 = 19 ≤ `TOTAL_DB_POOL_BUDGET` 20 (validado en `config.ts`); máximo
  observado 16 conexiones abiertas a la BD durante el ensayo (incluye el supervisor = 0, no usa BD).

## 4. Cómo reproducir

```bash
pnpm dev:stack                                 # con DATABASE_URL de la BD de ensayo y RATE_LIMIT_MAX=100000
pnpm dev:seed < admin.pass
DATABASE_URL=… pnpm load:seed                  # idempotente por suite de carga (externalId 9000)
pnpm load:explain -- --out explain.json
pnpm load:run -- --duration 300 --concurrency 10 --out carga.json < admin.pass   # --duration 30 para una prueba corta
```

Notas: la suite de carga no existe en el TestRail falso, así que una sincronización posterior (p. ej. al reiniciar
`control`, que sincroniza al arrancar) la **archiva** — comportamiento correcto de RF-TR-02; ejecutar el ensayo
antes de una nueva sync o reactivar la suite. `seed-5000.ts` reutiliza la última revisión `completa` del catálogo
para no reemplazar el manifiesto vigente.

## 5. Sin verificar
- Hardware objetivo (EC2 x86_64 2 vCPU / 8 GiB, ESP §12): el equipo de ensayo tiene 8 núcleos; repetir el ensayo en
  la instancia elegida antes de operar (mismo script contra la API detrás de Caddy, red interna).
- Perfil del panel con 5.000 casos (DOM paginado, renders, SSE): lo cubre el agente WEB.
