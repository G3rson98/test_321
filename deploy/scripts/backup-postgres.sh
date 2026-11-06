#!/usr/bin/env bash
# Katalyst — backup lógico diario de PostgreSQL, consistente, cifrado, con checksum y verificación.
# Requisitos: RNF-CON-04 (backup diario cifrado, retención 7 días, RPO <= 24 h), RNF-INF-03,
# ESP §18 (backup > 26 h alerta), ARQ §4/§6.
#
# Flujo:
#  1. Abre una transacción REPEATABLE READ READ ONLY y exporta su snapshot (pg_export_snapshot).
#  2. En ESE snapshot cuenta filas de las tablas críticas (manifiesto) y ejecuta pg_dump --snapshot.
#     Conteos y volcado corresponden exactamente al mismo instante -> restore-postgres.sh puede compararlos.
#  3. Verifica el volcado (pg_restore --list), lo cifra con la CLAVE PÚBLICA GPG de backups
#     (parámetro SSM <prefijo>/backup/gpg_public_key, tipo String; la clave privada la custodian los
#     administradores fuera del host), calcula SHA-256 y sube volcado + manifiesto a S3 (SSE del bucket).
#  4. Comprueba el objeto subido, registra el último éxito en /data/backups/state/last-success
#     (publish-metrics.sh publica BackupAgeHours) y elimina todo texto plano local.
# Programado por katalyst-backup.timer (diario). Antes de cada despliegue con migraciones: deploy.sh.
# Redis NO se respalda: es transporte reconstruible desde PostgreSQL (ESP §4).
KATALYST_SCRIPT=backup-postgres
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd aws jq docker gpg sha256sum flock
load_katalyst_env
: "${KATALYST_S3_BACKUPS_BUCKET:?}" "${KATALYST_SSM_PREFIX:?}"

REASON="diario"
while [ $# -gt 0 ]; do
  case "$1" in
    --reason) REASON="$2"; shift 2 ;;
    *) die "argumento desconocido: $1" ;;
  esac
done
[[ "$REASON" =~ ^[a-z0-9-]{1,32}$ ]] || die "--reason debe ser [a-z0-9-]{1,32}"

DATA_DIR="${KATALYST_DATA_DIR:-/data}"
STATE_DIR="$DATA_DIR/backups/state"
WORK_ROOT="$DATA_DIR/backups/work"
PREFIX="${KATALYST_BACKUP_PREFIX:-postgres/}"
PGUSER_NAME=katalyst
PGDB_NAME=katalyst
COUNT_TABLES="${BACKUP_COUNT_TABLES:-run,run_result,test_attempt,case_result,run_shard,schedule,schedule_occurrence,outbox_delivery,automated_test,test_case_link,testrail_case,case_revision,perf_sample,alert,audit_log,panel_user,artifact,event_log}"
[[ "$COUNT_TABLES" =~ ^[a-z0-9_,]+$ ]] || die "BACKUP_COUNT_TABLES solo admite [a-z0-9_,]"

install -d -m 0700 "$STATE_DIR" "$WORK_ROOT"
exec 9>/run/katalyst/backup.lock
flock -n 9 || die "otro backup está en curso"

started="$(date +%s)"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
day_path="$(date -u +%Y/%m/%d)"
key_base="${PREFIX}daily/${day_path}/katalyst-${ts}-${REASON}"
WORK="$(mktemp -d "$WORK_ROOT/run.XXXXXX")"

cleanup() {
  if [ -n "${PSQL_PID:-}" ]; then kill "$PSQL_PID" 2>/dev/null || true; fi
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi
}
trap cleanup EXIT

pg="$(service_container postgres)"
[ -n "$pg" ] || die "el contenedor postgres no está en ejecución"

# --- 1. Transacción con snapshot exportado (sesión psql en coproceso) -----------------------
coproc PSQL { docker exec -i "$pg" psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$PGUSER_NAME" -d "$PGDB_NAME" 2>&1; }
END_MARK="__KATALYST_END__"

psql_send() { printf '%s\n' "$1" >&"${PSQL[1]}"; }
psql_collect() { # lee hasta el marcador; falla si psql termina o tarda > 10 min
  local line
  while IFS= read -r -t 600 line <&"${PSQL[0]}"; do
    [ "$line" = "$END_MARK" ] && return 0
    printf '%s\n' "$line"
  done
  return 1
}

psql_send "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
psql_send "SELECT pg_export_snapshot();"
psql_send "SELECT '$END_MARK';"
snapshot="$(psql_collect)" || die "no se pudo exportar el snapshot"
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "snapshot inesperado de PostgreSQL"

psql_send "SELECT t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text FROM unnest(string_to_array('$COUNT_TABLES', ',')) AS t WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL ORDER BY t;"
psql_send "SELECT 'server_version=' || current_setting('server_version');"
psql_send "SELECT '$END_MARK';"
counts_raw="$(psql_collect)" || die "no se pudieron contar filas en el snapshot"

# --- 2. Volcado en el mismo snapshot ---------------------------------------------------------
docker exec "$pg" pg_dump -U "$PGUSER_NAME" -d "$PGDB_NAME" -Fc -Z 6 --snapshot="$snapshot" > "$WORK/dump" \
  || die "pg_dump falló"
psql_send "COMMIT;"
psql_send "\\q"
wait "$PSQL_PID" 2>/dev/null || true
PSQL_PID=""

# --- 3. Verificación, cifrado y checksum -------------------------------------------------------
toc_entries="$(docker exec -i "$pg" pg_restore --list < "$WORK/dump" | grep -cv '^;')" \
  || die "pg_restore --list no pudo leer el volcado"
[ "$toc_entries" -gt 0 ] || die "el volcado no contiene entradas"
plain_sha="$(sha256sum "$WORK/dump" | cut -d' ' -f1)"

aws ssm get-parameter --name "$KATALYST_SSM_PREFIX/backup/gpg_public_key" \
  --query Parameter.Value --output text > "$WORK/backup-pub.asc" \
  || die "no se pudo leer la clave pública de backups en SSM"
install -d -m 0700 "$WORK/gnupg"
gpg --homedir "$WORK/gnupg" --batch --yes --quiet --trust-model always --compress-algo none \
  --recipient-file "$WORK/backup-pub.asc" --output "$WORK/dump.gpg" --encrypt "$WORK/dump" \
  || die "cifrado GPG falló"
rm -f -- "$WORK/dump"
enc_sha="$(sha256sum "$WORK/dump.gpg" | cut -d' ' -f1)"
enc_size="$(stat -c %s "$WORK/dump.gpg")"

server_version="$(printf '%s\n' "$counts_raw" | sed -n 's/^server_version=//p')"
printf '%s\n' "$counts_raw" | grep -v '^server_version=' | grep '=' \
  | jq -R 'split("=") | {(.[0]): (.[1] | tonumber)}' | jq -s 'add // {}' > "$WORK/counts.json"

jq -n \
  --arg format "katalyst-pg-backup/1" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg reason "$REASON" \
  --arg key "${key_base}.dump.gpg" \
  --arg snapshot "$snapshot" \
  --arg server_version "$server_version" \
  --arg enc_sha "$enc_sha" \
  --arg plain_sha "$plain_sha" \
  --argjson size "$enc_size" \
  --argjson toc "$toc_entries" \
  --slurpfile counts "$WORK/counts.json" \
  '{format:$format, created_at:$created_at, reason:$reason, object_key:$key, snapshot:$snapshot,
    pg_server_version:$server_version, encryption:"gpg-public-key", encrypted_sha256:$enc_sha,
    plaintext_sha256:$plain_sha, encrypted_size_bytes:$size, toc_entries:$toc, row_counts:$counts[0]}' \
  > "$WORK/manifest.json"

# --- 4. Subida y comprobación ---------------------------------------------------------------
aws s3 cp "$WORK/dump.gpg" "s3://$KATALYST_S3_BACKUPS_BUCKET/${key_base}.dump.gpg" \
  --only-show-errors --checksum-algorithm SHA256 || die "subida del volcado a S3 falló"
aws s3 cp "$WORK/manifest.json" "s3://$KATALYST_S3_BACKUPS_BUCKET/${key_base}.manifest.json" \
  --only-show-errors --checksum-algorithm SHA256 --content-type application/json \
  || die "subida del manifiesto a S3 falló"

remote_size="$(aws s3api head-object --bucket "$KATALYST_S3_BACKUPS_BUCKET" --key "${key_base}.dump.gpg" \
  --query ContentLength --output text)" || die "no se pudo verificar el objeto subido"
[ "$remote_size" = "$enc_size" ] || die "tamaño remoto ($remote_size) distinto del local ($enc_size)"

date +%s > "$STATE_DIR/last-success.tmp"
mv -f "$STATE_DIR/last-success.tmp" "$STATE_DIR/last-success"
cp -f "$WORK/manifest.json" "$STATE_DIR/last-manifest.json"

log info "backup verificado: s3://$KATALYST_S3_BACKUPS_BUCKET/${key_base}.dump.gpg (${enc_size} bytes, $(( $(date +%s) - started )) s)"
