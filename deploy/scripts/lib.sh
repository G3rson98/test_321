#!/usr/bin/env bash
# Katalyst — funciones comunes de los scripts del host. Requisitos: RNF-OBS-01 (logs estructurados),
# RNF-SEG-01 (nunca imprimir secretos).
# Uso: source "$(dirname "$0")/lib.sh"

set -euo pipefail
umask 077

KATALYST_INFRA_ENV="${KATALYST_INFRA_ENV:-/etc/katalyst/infra.env}"
KATALYST_SITE_ENV="${KATALYST_SITE_ENV:-/etc/katalyst/site.env}"
KATALYST_RELEASE_DIR="${KATALYST_RELEASE_DIR:-/opt/katalyst/current}"

# Log JSON de una línea (sin secretos). Nivel: info|warn|error.
log() {
  local level="$1"; shift
  local msg="$*"
  printf '{"ts":"%s","level":"%s","script":"%s","msg":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "${KATALYST_SCRIPT:-$(basename "$0")}" \
    "$(printf '%s' "$msg" | jq -Rs .)" >&2
}

die() {
  log error "$*"
  exit 1
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "comando requerido no disponible: $c"
  done
}

# Carga variables NO secretas de infraestructura/sitio (KEY=VALUE, sin evaluación de shell).
load_env_file() {
  local file="$1" line key value
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    export "$key=$value"
  done < "$file"
}

load_katalyst_env() {
  load_env_file "$KATALYST_INFRA_ENV"
  load_env_file "$KATALYST_SITE_ENV"
  : "${AWS_REGION:?AWS_REGION no definido en $KATALYST_INFRA_ENV}"
  export AWS_DEFAULT_REGION="$AWS_REGION"
}

# ID del contenedor de un servicio Compose del proyecto katalyst (vacío si no corre).
service_container() {
  docker ps -q \
    --filter "label=com.docker.compose.project=katalyst" \
    --filter "label=com.docker.compose.service=$1" | head -n1
}

# Escritura atómica de un archivo de secreto: contenido por stdin, nunca por argumentos.
# write_secret_file <ruta> <uid> <gid> <modo>
write_secret_file() {
  local dest="$1" uid="$2" gid="$3" mode="$4" tmp
  tmp="$(mktemp "$(dirname "$dest")/.tmp.XXXXXX")"
  cat > "$tmp"
  chown "$uid:$gid" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}
