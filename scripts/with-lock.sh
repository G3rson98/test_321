#!/usr/bin/env bash
# Serializa operaciones que modifican estado compartido del workspace (pnpm add/install,
# cambios en prisma/schema.prisma + migraciones) entre varios agentes trabajando en paralelo.
# Uso: scripts/with-lock.sh <comando...>
set -euo pipefail
LOCK_DIR="${KATALYST_LOCK_DIR:-/tmp/katalyst-workspace.lock}"
waited=0
until mkdir "$LOCK_DIR" 2>/dev/null; do
  # Lock huérfano de más de 15 min: se libera.
  if [ -d "$LOCK_DIR" ] && [ "$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR") ))" -gt 900 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    continue
  fi
  sleep 3; waited=$((waited+3))
  [ $((waited % 60)) -eq 0 ] && echo "with-lock: esperando lock ($waited s)..." >&2
done
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
"$@"
