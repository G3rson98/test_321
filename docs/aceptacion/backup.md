# Aceptación — backup y restauración de PostgreSQL (RNF-CON-04)

Fecha: 2026-11-06 · Script: [`scripts/backup-restore-local.sh`](../../scripts/backup-restore-local.sh)
(`pnpm backup:local`), equivalente local de `deploy/scripts/backup-postgres.sh` + `restore-postgres.sh`.

## 1. Qué se probó localmente

Misma lógica que producción, paso a paso:
1. Sesión `psql` en coproceso: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` + `pg_export_snapshot()`.
2. Conteo de las 18 tablas críticas (`run, run_result, test_attempt, case_result, run_shard, schedule,
   schedule_occurrence, outbox_delivery, automated_test, test_case_link, testrail_case, case_revision, perf_sample,
   alert, audit_log, panel_user, artifact, event_log`) **en ese snapshot**.
3. `pg_dump -Fc -Z 6 --snapshot=<snapshot>` (mismo instante que los conteos) y verificación `pg_restore --list`.
4. Cifrado con **clave pública** (producción: GPG con la clave pública de SSM; local: gpg no instalado ⇒ OpenSSL
   CMS AES-256-CBC con un certificado RSA-3072 efímero) y SHA-256 del texto plano y del cifrado; manifiesto
   `katalyst-pg-backup/1` idéntico al de producción.
5. Restauración: verificación SHA-256 del cifrado → descifrado con la **clave privada** → verificación SHA-256 del
   texto plano → **BD limpia nueva** (`createdb katalyst_restore_<ts>`) → `pg_restore --single-transaction
   --exit-on-error` → conteos comparados con el manifiesto → la BD temporal se elimina.

Resultado sobre `katalyst_accept` **con el stack en marcha** (datos del ensayo de carga + corridas reales):

| Métrica | Valor |
| --- | --- |
| Filas en tablas críticas | 58.874 (p. ej. `audit_log` 20.076, `run_result` 7.518, `case_result` 7.518, `test_attempt` 6.772, `testrail_case` 5.609, `automated_test` 5.009, `test_case_link` 5.009, `case_revision` 609, `run` 309, `event_log` 232, `schedule` 123, `artifact` 46, `outbox_delivery` 33) |
| Volcado | 3.592.500 B (399 entradas TOC) → 3.593.065 B cifrado |
| Duración | backup < 1 s; `pg_restore` 2 s; total 2 s (RTO de la BD de este tamaño muy por debajo de 4 h) |
| Verificación | SHA-256 cifrado y texto plano OK; **conteos restaurados idénticos en las 18 tablas** (`mismatches: []`); 2 migraciones Prisma presentes en la BD restaurada (esquema completo, incl. `pg_trgm`) |

Con esto quedan restaurables el catálogo (`automated_test`, `test_case_link`, `testrail_case`, `case_revision`) y la
cola de publicación (`outbox_delivery`, fuente de verdad de las entregas a TestRail); Redis no se respalda: el
reconciliador del proceso `control` reconstruye colas desde PostgreSQL (docs/operacion.md §12).

## 2. Qué requiere AWS (no probado aquí)

- Subida/descarga S3 (`aws s3 cp --checksum-algorithm SHA256`, `head-object`), versionado y retención 7 + 7 días,
  política que impide al rol del host borrar backups.
- Clave pública GPG en SSM (`<prefijo>/backup/gpg_public_key`) y custodia de la privada fuera del host.
- Contenedor `postgres` temporal con `--network none` (restore-postgres.sh) y `docker exec pg_dump` del servicio.
- Timer diario `katalyst-backup.timer`, métrica `BackupAgeHours` y alarma de 26 h; `deploy.sh` con backup
  `pre-deploy`. Primera prueba real a registrar en la bitácora de docs/operacion.md §3.1 antes de operar.
