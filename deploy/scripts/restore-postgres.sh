#!/usr/bin/env bash
# Katalyst — prueba de restauración de un backup de PostgreSQL en un contenedor TEMPORAL aislado.
# Requisitos: RNF-CON-04 ("demostrar restauración antes de operar"; RPO <= 24 h, RTO objetivo <= 4 h),
# RNF-INF-03, ARQ §4 ("restauración probada en contenedor local temporal"), ARQ §7.
#
# NO toca la base de datos en servicio. Pasos:
#  1. Descarga el volcado cifrado y su manifiesto (el último o --key), verifica SHA-256 del cifrado.
#  2. Descifra con la clave PRIVADA de backups, provista por el operador en un GNUPGHOME temporal
#     (preferible tmpfs; la clave privada nunca se guarda en el host ni en SSM legible por el host).
#  3. Verifica SHA-256 del texto plano, levanta postgres temporal con --network none, ejecuta
#     pg_restore --single-transaction --exit-on-error y compara conteos con los del manifiesto
#     (tomados en el mismo snapshot que el volcado: deben coincidir exactamente).
#  4. Informa duración (insumo de RTO) y elimina contenedor y texto plano (salvo --keep).
#
# Uso:
#   restore-postgres.sh --gnupghome /dev/shm/katalyst-gpg [--latest | --key postgres/daily/AAAA/MM/DD/x.dump.gpg] [--keep]
# Procedimiento de restauración REAL sobre el servicio: docs/operacion.md §3.
KATALYST_SCRIPT=restore-postgres
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd aws jq docker gpg sha256sum
load_katalyst_env
: "${KATALYST_S3_BACKUPS_BUCKET:?}"

KEY=""; GNUPG=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --latest) KEY=""; shift ;;
    --key) KEY="$2"; shift 2 ;;
    --gnupghome) GNUPG="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) die "argumento desconocido: $1" ;;
  esac
done
[ -n "$GNUPG" ] && [ -d "$GNUPG" ] || die "--gnupghome <dir> con la clave privada de backups es obligatorio"

if [ -r "$KATALYST_RELEASE_DIR/release.env" ]; then
  load_env_file "$KATALYST_RELEASE_DIR/release.env"
fi
IMAGE="${RESTORE_POSTGRES_IMAGE:-${POSTGRES_IMAGE:-}}"
[ -n "$IMAGE" ] || die "definir POSTGRES_IMAGE (release.env) o RESTORE_POSTGRES_IMAGE"

PREFIX="${KATALYST_BACKUP_PREFIX:-postgres/}"
if [ -z "$KEY" ]; then
  KEY="$(aws s3api list-objects-v2 --bucket "$KATALYST_S3_BACKUPS_BUCKET" --prefix "${PREFIX}daily/" \
    --query "sort_by(Contents[?ends_with(Key, '.dump.gpg')], &LastModified)[-1].Key" --output text)"
  [ -n "$KEY" ] && [ "$KEY" != "None" ] || die "no hay backups en s3://$KATALYST_S3_BACKUPS_BUCKET/${PREFIX}daily/"
fi
[[ "$KEY" == *.dump.gpg ]] || die "la key debe terminar en .dump.gpg"
MANIFEST_KEY="${KEY%.dump.gpg}.manifest.json"

started="$(date +%s)"
WORK_ROOT="${KATALYST_DATA_DIR:-/data}/restore-work"
install -d -m 0700 "$WORK_ROOT"
WORK="$(mktemp -d "$WORK_ROOT/restore.XXXXXX")"
CONTAINER="katalyst-restore-$(date -u +%Y%m%dT%H%M%SZ)"

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf -- "$WORK"; fi
  else
    log warn "--keep: contenedor $CONTAINER y $WORK conservados; eliminarlos al terminar la inspección"
  fi
}
trap cleanup EXIT

log info "restaurando s3://$KATALYST_S3_BACKUPS_BUCKET/$KEY"
aws s3 cp "s3://$KATALYST_S3_BACKUPS_BUCKET/$KEY" "$WORK/dump.gpg" --only-show-errors || die "descarga del volcado falló"
aws s3 cp "s3://$KATALYST_S3_BACKUPS_BUCKET/$MANIFEST_KEY" "$WORK/manifest.json" --only-show-errors || die "descarga del manifiesto falló"

[ "$(jq -r .format "$WORK/manifest.json")" = "katalyst-pg-backup/1" ] || die "formato de manifiesto desconocido"
[ "$(sha256sum "$WORK/dump.gpg" | cut -d' ' -f1)" = "$(jq -r .encrypted_sha256 "$WORK/manifest.json")" ] \
  || die "SHA-256 del volcado cifrado no coincide con el manifiesto"

gpg --homedir "$GNUPG" --batch --quiet --yes --output "$WORK/dump" --decrypt "$WORK/dump.gpg" \
  || die "no se pudo descifrar (¿clave privada correcta en --gnupghome?)"
rm -f -- "$WORK/dump.gpg"
[ "$(sha256sum "$WORK/dump" | cut -d' ' -f1)" = "$(jq -r .plaintext_sha256 "$WORK/manifest.json")" ] \
  || die "SHA-256 del volcado descifrado no coincide con el manifiesto"
chmod 0644 "$WORK/dump"

docker run -d --name "$CONTAINER" --network none \
  --memory 1536m --cpus 1 --pids-limit 256 \
  --security-opt no-new-privileges:true \
  --label katalyst.role=restore-test \
  -e POSTGRES_USER=katalyst -e POSTGRES_DB=katalyst -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$WORK/dump:/restore/dump:ro" \
  "$IMAGE" >/dev/null || die "no se pudo iniciar el contenedor temporal"

ready=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" pg_isready -q -U katalyst -d katalyst -h 127.0.0.1 2>/dev/null; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || die "el PostgreSQL temporal no quedó listo"

restore_started="$(date +%s)"
docker exec "$CONTAINER" pg_restore -U katalyst -d katalyst --exit-on-error --single-transaction /restore/dump \
  || die "pg_restore falló"
restore_seconds=$(( $(date +%s) - restore_started ))

tables="$(jq -r '.row_counts | keys | join(",")' "$WORK/manifest.json")"
[[ "$tables" =~ ^[a-z0-9_,]*$ ]] || die "nombres de tabla inesperados en el manifiesto"
if [ -n "$tables" ]; then
  docker exec "$CONTAINER" psql -X -q -A -t -v ON_ERROR_STOP=1 -U katalyst -d katalyst -c \
    "SELECT t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t), false, true, '')))[1]::text FROM unnest(string_to_array('$tables', ',')) AS t WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL ORDER BY t;" \
    | jq -R 'split("=") | {(.[0]): (.[1] | tonumber)}' | jq -s 'add // {}' > "$WORK/restored-counts.json"
else
  echo '{}' > "$WORK/restored-counts.json"
fi

diff_json="$(jq -n --slurpfile a "$WORK/manifest.json" --slurpfile b "$WORK/restored-counts.json" \
  '[$a[0].row_counts | to_entries[] | select(($b[0][.key] // -1) != .value) | {tabla: .key, esperado: .value, restaurado: ($b[0][.key] // null)}]')"
total_seconds=$(( $(date +%s) - started ))

jq -n --arg key "$KEY" --argjson diff "$diff_json" --argjson rs "$restore_seconds" --argjson ts "$total_seconds" \
  --slurpfile counts "$WORK/restored-counts.json" --slurpfile m "$WORK/manifest.json" \
  '{backup: $key, backup_created_at: $m[0].created_at, restore_seconds: $rs, total_seconds: $ts,
    row_counts: $counts[0], mismatches: $diff, ok: ($diff | length == 0)}'

[ "$(printf '%s' "$diff_json" | jq 'length')" = "0" ] || die "los conteos restaurados no coinciden con el manifiesto"
log info "restauración verificada en ${total_seconds}s (pg_restore ${restore_seconds}s); registrar en docs/operacion.md (bitácora de pruebas)"
