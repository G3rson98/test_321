#!/usr/bin/env bash
# Katalyst — despliegue de una versión de la APLICACIÓN sin reprovisionar infraestructura, con rollback.
# Requisitos: ESP §18 ("actualizar aplicación no reprovisiona toda la infraestructura"; "rollback y backup
# antes de cambios destructivos"), ARQ §5, RNF-CON-04, RNF-MAN-02.
#
# Uso (root, sesión SSM en el host):
#   deploy.sh /opt/katalyst/releases/<versión>     despliega esa versión
#   deploy.sh --rollback                           vuelve a la versión anterior (solo imágenes)
# Una versión es un directorio con: deploy/ (copia de este directorio del repo en el commit liberado)
# y release.env (imágenes por tag+digest). Cómo llega al host depende de la plataforma Git/CI (ESP §12).
#
# Política de migraciones: expandir/contraer (compatibles hacia atrás durante una versión). El rollback
# NO revierte migraciones; si una versión necesita una migración incompatible, se restaura desde el
# backup previo al despliegue (docs/operacion.md §3).
KATALYST_SCRIPT=deploy
source "$(dirname "$(readlink -f "$0")")/lib.sh"
[ "$(id -u)" -eq 0 ] || die "ejecutar como root"
require_cmd docker readlink

ROOT=/opt/katalyst
CURRENT="$ROOT/current"
PREVIOUS="$ROOT/previous"

validate_release() {
  local dir="$1" var val
  [ -r "$dir/release.env" ] && [ -r "$dir/deploy/docker-compose.yml" ] || die "versión incompleta en $dir"
  for var in KATALYST_API_IMAGE KATALYST_RUNNER_IMAGE KATALYST_WEB_IMAGE KATALYST_EXECUTOR_IMAGE POSTGRES_IMAGE REDIS_IMAGE; do
    val="$(sed -n "s/^$var=//p" "$dir/release.env")"
    [[ "$val" =~ @sha256:[0-9a-f]{64}$ ]] || die "$var debe fijarse por digest (@sha256:...) en $dir/release.env"
  done
}

switch_to() { # switch_to <dir>
  local target="$1" old=""
  [ -L "$CURRENT" ] && old="$(readlink -f "$CURRENT")"
  ln -sfn "$target" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"
  if [ -n "$old" ] && [ "$old" != "$target" ]; then ln -sfn "$old" "$PREVIOUS"; fi
}

up_and_check() {
  "$CURRENT/deploy/scripts/compose.sh" up -d --wait --remove-orphans
  "$CURRENT/deploy/scripts/smoke-test.sh" --host
}

if [ "${1:-}" = "--rollback" ]; then
  [ -L "$PREVIOUS" ] || die "no hay versión anterior registrada"
  target="$(readlink -f "$PREVIOUS")"
  validate_release "$target"
  log warn "rollback a $target (las migraciones aplicadas NO se revierten)"
  switch_to "$target"
  up_and_check || die "rollback desplegado pero el smoke test falla: ver docs/operacion.md §5"
  log info "rollback completado"
  exit 0
fi

NEW="$(readlink -f "${1:?uso: deploy.sh <dir-versión> | --rollback}")"
[[ "$NEW" == "$ROOT/releases/"* ]] || die "la versión debe estar bajo $ROOT/releases/"
validate_release "$NEW"

log info "descargando imágenes de $NEW"
KATALYST_RELEASE_DIR="$NEW" "$NEW/deploy/scripts/compose.sh" --profile tools pull --quiet

if [ -L "$CURRENT" ] && [ -n "$(service_container postgres)" ]; then
  log info "backup previo al despliegue"
  "$CURRENT/deploy/scripts/backup-postgres.sh" --reason pre-deploy
fi

log info "aplicando migraciones"
KATALYST_RELEASE_DIR="$NEW" "$NEW/deploy/scripts/compose.sh" up -d --wait postgres
KATALYST_RELEASE_DIR="$NEW" "$NEW/deploy/scripts/compose.sh" run --rm migrate

switch_to "$NEW"
"$CURRENT/deploy/scripts/install-host.sh"
if ! up_and_check; then
  log error "la nueva versión no pasó el smoke test; ejecutar deploy.sh --rollback si corresponde"
  exit 1
fi
log info "versión $(sed -n 's/^KATALYST_VERSION=//p' "$CURRENT/release.env") desplegada"
