#!/usr/bin/env bash
# Katalyst — limpieza de storageState/secretos de asignación huérfanos y temporales de corridas.
# Requisitos: RNF-SEG-01 ("estado autenticado temporal se borra al terminar"), ESP §13.7 ("después de un
# crash, limpiar archivos huérfanos antes de aceptar trabajo nuevo"), §13.3 (tarea posterior para residuos),
# ESP §18 (cuota temporal 1 GiB por corrida).
#
# Se ejecuta: (a) como ExecStartPre de katalyst.service, ANTES de que el supervisor acepte trabajo;
# (b) cada hora por katalyst-cleanup.timer. Idempotente; nunca toca shards con contenedor vivo.
#  - /run/katalyst/shards/<shardId>   secretos de asignación (tmpfs): se borran si no hay ejecutor vivo
#  - contenedores ejecutores detenidos (label katalyst.role=executor): se eliminan
#  - /data/runner/runs/<runId>        temporales de corrida: se borran si no hay ejecutor vivo de esa
#                                     corrida y tienen más de RUN_TMP_MAX_AGE_MIN minutos
#  - /data/runner/checkouts/<commit>  checkouts sin uso en CHECKOUT_MAX_AGE_DAYS días (por mtime: /data se
#                                     monta con noatime; el supervisor hace touch del checkout al usarlo)
KATALYST_SCRIPT=cleanup-runner-state
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd docker find
load_katalyst_env

SHARDS_DIR=/run/katalyst/shards
RUNS_DIR="${KATALYST_DATA_DIR:-/data}/runner/runs"
CHECKOUTS_DIR="${KATALYST_DATA_DIR:-/data}/runner/checkouts"
RUN_TMP_MAX_AGE_MIN="${RUN_TMP_MAX_AGE_MIN:-90}"
CHECKOUT_MAX_AGE_DAYS="${CHECKOUT_MAX_AGE_DAYS:-14}"

# Ejecutores detenidos o muertos (normalmente usan --rm; esto cubre crashes del daemon/host).
mapfile -t dead < <(docker ps -aq --filter label=katalyst.role=executor --filter status=exited --filter status=dead --filter status=created)
if [ "${#dead[@]}" -gt 0 ]; then
  docker rm -f "${dead[@]}" >/dev/null
  log info "ejecutores detenidos eliminados: ${#dead[@]}"
fi

declare -A live_shards=() live_runs=()
while read -r shard run; do
  [ -n "$shard" ] && live_shards["$shard"]=1
  [ -n "$run" ] && live_runs["$run"]=1
done < <(docker ps --filter label=katalyst.role=executor --format '{{.Label "katalyst.shard"}} {{.Label "katalyst.run"}}')

removed=0
if [ -d "$SHARDS_DIR" ]; then
  for d in "$SHARDS_DIR"/*; do
    [ -d "$d" ] || continue
    id="$(basename "$d")"
    [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || continue
    if [ -z "${live_shards[$id]:-}" ]; then
      find "$d" -mindepth 1 -delete
      rmdir "$d"
      removed=$((removed + 1))
    fi
  done
fi
[ "$removed" -gt 0 ] && log warn "secretos/storageState de asignaciones huérfanas eliminados: $removed"

removed=0
if [ -d "$RUNS_DIR" ]; then
  while IFS= read -r -d '' d; do
    id="$(basename "$d")"
    [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || continue
    if [ -z "${live_runs[$id]:-}" ]; then
      find "$d" -mindepth 1 -delete
      rmdir "$d"
      removed=$((removed + 1))
    fi
  done < <(find "$RUNS_DIR" -mindepth 1 -maxdepth 1 -type d -mmin +"$RUN_TMP_MAX_AGE_MIN" -print0)
fi
[ "$removed" -gt 0 ] && log info "temporales de corridas terminadas eliminados: $removed"

if [ -d "$CHECKOUTS_DIR" ]; then
  while IFS= read -r -d '' d; do
    find "$d" -mindepth 1 -delete
    rmdir "$d"
    log info "checkout sin uso eliminado: $(basename "$d")"
  done < <(find "$CHECKOUTS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$CHECKOUT_MAX_AGE_DAYS" -print0)
fi

log info "limpieza de estado del runner completada"
