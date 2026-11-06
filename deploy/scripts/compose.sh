#!/usr/bin/env bash
# Katalyst — envoltorio de Docker Compose en el host: fija proyecto, archivos y entornos NO secretos.
# Requisitos: ESP §18 ("actualizar aplicación no reprovisiona infraestructura"), RNF-MAN-02.
#   compose.sh up -d --wait | compose.sh ps | compose.sh run --rm migrate | compose.sh logs api
set -euo pipefail

RELEASE_DIR="${KATALYST_RELEASE_DIR:-/opt/katalyst/current}"
INFRA_ENV="${KATALYST_INFRA_ENV:-/etc/katalyst/infra.env}"
SITE_ENV="${KATALYST_SITE_ENV:-/etc/katalyst/site.env}"

[ -r "$RELEASE_DIR/deploy/docker-compose.yml" ] || { echo "no existe $RELEASE_DIR/deploy/docker-compose.yml" >&2; exit 1; }
[ -r "$RELEASE_DIR/release.env" ] || { echo "no existe $RELEASE_DIR/release.env" >&2; exit 1; }
[ -r "$INFRA_ENV" ] || { echo "no existe $INFRA_ENV (lo escribe user-data de Terraform)" >&2; exit 1; }

DOCKER_GID="$(getent group docker | cut -d: -f3)"
export DOCKER_GID

args=(--project-name katalyst
      --project-directory "$RELEASE_DIR/deploy"
      -f "$RELEASE_DIR/deploy/docker-compose.yml"
      --env-file "$INFRA_ENV")
[ -r "$SITE_ENV" ] && args+=(--env-file "$SITE_ENV")
args+=(--env-file "$RELEASE_DIR/release.env")

exec docker compose "${args[@]}" "$@"
