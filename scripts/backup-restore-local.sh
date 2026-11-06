#!/usr/bin/env bash
# =============================================================================
# Ensayo LOCAL de backup/restauración de PostgreSQL (RNF-CON-04) con la MISMA lógica que
# deploy/scripts/backup-postgres.sh + restore-postgres.sh, sin Docker, S3 ni SSM:
#   backup : transacción REPEATABLE READ READ ONLY + pg_export_snapshot → conteos de tablas críticas EN el snapshot →
#            pg_dump -Fc -Z 6 --snapshot → pg_restore --list → cifrado con CLAVE PÚBLICA (gpg si está instalado;
#            si no, OpenSSL CMS AES-256 con un certificado efímero) → SHA-256 de texto plano y cifrado → manifiesto
#            katalyst-pg-backup/1 (mismo formato que producción).
#   restore: verifica SHA-256 del cifrado → descifra con la clave PRIVADA → verifica SHA-256 del texto plano → BD
#            LIMPIA nueva (createdb) → pg_restore --single-transaction --exit-on-error → compara conteos con el
#            manifiesto (deben coincidir exactamente) → informa duración (insumo RTO) → borra la BD temporal.
# Equivalencias con producción: S3 ⇒ directorio local $OUT; SSM gpg_public_key ⇒ clave pública efímera en $OUT/keys;
#   contenedor postgres temporal --network none ⇒ base nueva en el PostgreSQL local.
#
# Uso: DATABASE_URL=postgresql://katalyst:…@localhost:5432/katalyst_accept scripts/backup-restore-local.sh [--keep] [--out DIR]
# =============================================================================
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?definir DATABASE_URL de la BD a respaldar}"
OUT="${TMPDIR:-/tmp}/katalyst-backup-local"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done
COUNT_TABLES="${BACKUP_COUNT_TABLES:-run,run_result,test_attempt,case_result,run_shard,schedule,schedule_occurrence,outbox_delivery,automated_test,test_case_link,testrail_case,case_revision,perf_sample,alert,audit_log,panel_user,artifact,event_log}"
[[ "$COUNT_TABLES" =~ ^[a-z0-9_,]+$ ]] || { echo "BACKUP_COUNT_TABLES solo admite [a-z0-9_,]" >&2; exit 2; }

log() { printf '[backup-local] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
fsize() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }
for c in psql pg_dump pg_restore createdb dropdb jq shasum openssl; do command -v "$c" >/dev/null || die "falta $c"; done

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
chmod 700 "$OUT"
WORK="$(mktemp -d "$OUT/run.XXXXXX")"
BASE_URL="${DATABASE_URL%/*}"
RESTORE_DB="katalyst_restore_${ts,,}"
RESTORE_URL="$BASE_URL/$RESTORE_DB"
cleanup() {
  if [ -n "${PSQL_PID:-}" ]; then kill "$PSQL_PID" 2>/dev/null || true; fi
  if [ "$KEEP" -eq 0 ]; then
    dropdb --if-exists --maintenance-db="$DATABASE_URL" "$RESTORE_DB" 2>/dev/null || true
    rm -rf -- "$WORK"
  else
    log "--keep: BD $RESTORE_DB y $WORK conservados"
  fi
}
trap cleanup EXIT
started="$(date +%s)"

# ---------------------------------------------------------------- BACKUP
coproc PSQL { psql -X -q -A -t -v ON_ERROR_STOP=1 "$DATABASE_URL" 2>&1; }
END_MARK="__KATALYST_END__"
psql_send() { printf '%s\n' "$1" >&"${PSQL[1]}"; }
psql_collect() {
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
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "snapshot inesperado: $snapshot"
psql_send "SELECT t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text FROM unnest(string_to_array('$COUNT_TABLES', ',')) AS t WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL ORDER BY t;"
psql_send "SELECT 'server_version=' || current_setting('server_version');"
psql_send "SELECT '$END_MARK';"
counts_raw="$(psql_collect)" || die "no se pudieron contar filas en el snapshot"

dump_started="$(date +%s)"
pg_dump -d "$DATABASE_URL" -Fc -Z 6 --snapshot="$snapshot" -f "$WORK/dump" || die "pg_dump falló"
dump_seconds=$(( $(date +%s) - dump_started ))
psql_send "COMMIT;"
psql_send "\\q"
wait "$PSQL_PID" 2>/dev/null || true
PSQL_PID=""

toc_entries="$(pg_restore --list "$WORK/dump" | grep -cv '^;')" || die "pg_restore --list no pudo leer el volcado"
[ "$toc_entries" -gt 0 ] || die "el volcado no contiene entradas"
plain_sha="$(sha "$WORK/dump")"
plain_size="$(fsize "$WORK/dump")"

# Par de claves efímero: la PÚBLICA cifra (en producción: SSM <prefijo>/backup/gpg_public_key); la PRIVADA solo la
# usa el paso de restauración (en producción la custodian los administradores fuera del host).
mkdir -p "$WORK/keys" && chmod 700 "$WORK/keys"
if command -v gpg >/dev/null; then
  ENC=gpg
  export GNUPGHOME="$WORK/keys/gnupg"; mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-generate-key "katalyst-backup-local <backup@example.test>" rsa3072 encr never
  gpg --batch --quiet --yes --trust-model always --compress-algo none -r backup@example.test -o "$WORK/dump.enc" --encrypt "$WORK/dump"
else
  ENC=openssl-cms-aes256
  openssl req -x509 -newkey rsa:3072 -nodes -days 1 -subj "/CN=katalyst-backup-local" \
    -keyout "$WORK/keys/backup-priv.pem" -out "$WORK/keys/backup-pub.pem" >/dev/null 2>&1 || die "no se pudo generar el par de claves"
  openssl cms -encrypt -binary -aes-256-cbc -outform DER -in "$WORK/dump" -out "$WORK/dump.enc" "$WORK/keys/backup-pub.pem" \
    || die "cifrado CMS falló"
fi
rm -f -- "$WORK/dump"
enc_sha="$(sha "$WORK/dump.enc")"
enc_size="$(fsize "$WORK/dump.enc")"
server_version="$(printf '%s\n' "$counts_raw" | sed -n 's/^server_version=//p')"
printf '%s\n' "$counts_raw" | grep -v '^server_version=' | grep '=' \
  | jq -R 'split("=") | {(.[0]): (.[1] | tonumber)}' | jq -s 'add // {}' > "$WORK/counts.json"
jq -n --arg format "katalyst-pg-backup/1" --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg reason "ensayo-local" \
  --arg key "local/katalyst-${ts}.dump.enc" --arg snapshot "$snapshot" --arg server_version "$server_version" \
  --arg enc "$ENC" --arg enc_sha "$enc_sha" --arg plain_sha "$plain_sha" --argjson size "$enc_size" \
  --argjson toc "$toc_entries" --slurpfile counts "$WORK/counts.json" \
  '{format:$format, created_at:$created_at, reason:$reason, object_key:$key, snapshot:$snapshot,
    pg_server_version:$server_version, encryption:$enc, encrypted_sha256:$enc_sha, plaintext_sha256:$plain_sha,
    encrypted_size_bytes:$size, toc_entries:$toc, row_counts:$counts[0]}' > "$WORK/manifest.json"
backup_seconds=$(( $(date +%s) - started ))
log "backup: $(jq -r '.row_counts | to_entries | map(.value) | add' "$WORK/manifest.json") filas en $(jq '.row_counts|length' "$WORK/manifest.json") tablas críticas, ${plain_size} B → ${enc_size} B cifrado (${ENC}), ${backup_seconds} s"

# ---------------------------------------------------------------- RESTORE (BD limpia)
restore_started="$(date +%s)"
[ "$(sha "$WORK/dump.enc")" = "$(jq -r .encrypted_sha256 "$WORK/manifest.json")" ] || die "SHA-256 del cifrado no coincide"
if [ "$ENC" = gpg ]; then
  gpg --batch --quiet --yes -o "$WORK/restore.dump" --decrypt "$WORK/dump.enc" || die "no se pudo descifrar"
else
  openssl cms -decrypt -binary -inform DER -in "$WORK/dump.enc" -inkey "$WORK/keys/backup-priv.pem" -out "$WORK/restore.dump" \
    || die "no se pudo descifrar"
fi
[ "$(sha "$WORK/restore.dump")" = "$(jq -r .plaintext_sha256 "$WORK/manifest.json")" ] || die "SHA-256 del texto plano no coincide"
createdb --maintenance-db="$DATABASE_URL" "$RESTORE_DB" || die "createdb falló"
# Extensión pg_trgm (índices GIN de búsqueda) la crea la propia migración incluida en el volcado.
pg_restore -d "$RESTORE_URL" --no-owner --exit-on-error --single-transaction "$WORK/restore.dump" || die "pg_restore falló"
pg_restore_seconds=$(( $(date +%s) - restore_started ))
tables="$(jq -r '.row_counts | keys | join(",")' "$WORK/manifest.json")"
psql -X -q -A -t -v ON_ERROR_STOP=1 "$RESTORE_URL" -c \
  "SELECT t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text FROM unnest(string_to_array('$tables', ',')) AS t WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL ORDER BY t;" \
  | jq -R 'split("=") | {(.[0]): (.[1] | tonumber)}' | jq -s 'add // {}' > "$WORK/restored-counts.json"
migrations="$(psql -X -A -t "$RESTORE_URL" -c "select count(*) from _prisma_migrations where finished_at is not null")"
diff_json="$(jq -n --slurpfile a "$WORK/manifest.json" --slurpfile b "$WORK/restored-counts.json" \
  '[$a[0].row_counts | to_entries[] | select(($b[0][.key] // -1) != .value) | {tabla: .key, esperado: .value, restaurado: ($b[0][.key] // null)}]')"
total_seconds=$(( $(date +%s) - started ))
jq -n --slurpfile m "$WORK/manifest.json" --slurpfile r "$WORK/restored-counts.json" --argjson diff "$diff_json" \
  --argjson bs "$backup_seconds" --argjson ds "$dump_seconds" --argjson rs "$pg_restore_seconds" --argjson ts "$total_seconds" \
  --arg db "$RESTORE_DB" --argjson mig "$migrations" --argjson plain "$plain_size" \
  '{manifest: ($m[0] | del(.row_counts)), plaintext_size_bytes: $plain, backup_seconds: $bs, pg_dump_seconds: $ds,
    restore_seconds: $rs, total_seconds: $ts, restored_db: $db, prisma_migrations_restored: $mig,
    row_counts_backup: $m[0].row_counts, row_counts_restored: $r[0], mismatches: $diff, ok: ($diff | length == 0)}'
[ "$(printf '%s' "$diff_json" | jq 'length')" = "0" ] || die "los conteos restaurados no coinciden con el manifiesto"
log "restauración verificada en BD limpia $RESTORE_DB: conteos idénticos (pg_restore ${pg_restore_seconds} s, total ${total_seconds} s)"
