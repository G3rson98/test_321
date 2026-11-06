#!/usr/bin/env bash
# Katalyst — rotación de logs locales y limpieza de imágenes sin uso.
# Requisitos: ESP §18 / ARQ §6 ("CloudWatch 14 días y rotación local"), RNF-INF-03 (límites de disco).
# Los logs de contenedores ya rotan por Docker (json-file, 20 MiB x 5). Este script (diario,
# katalyst-logrotate.timer) rota /var/log/katalyst, acota el journal y elimina imágenes no usadas > 7 días.
KATALYST_SCRIPT=rotate-logs
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd logrotate journalctl docker

logrotate --state /var/lib/logrotate/katalyst.status /etc/logrotate.d/katalyst
journalctl --vacuum-time=14d --vacuum-size=500M >/dev/null 2>&1 || log warn "no se pudo acotar el journal"
# Solo imágenes no referenciadas por ningún contenedor; las de la versión actual y la anterior
# siguen referenciadas o se vuelven a descargar por digest al hacer rollback.
docker image prune -a -f --filter "until=168h" >/dev/null || log warn "docker image prune falló"
docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true
log info "rotación y limpieza completadas"
