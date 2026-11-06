#!/usr/bin/env bash
# =============================================================================
# Stack LOCAL de desarrollo/aceptación de Katalyst (sin Docker, sin AWS, sin tocar DeltaX):
#   fake-testrail (4010) · fake-deltax (4020, fixture HTML) · api (3000) · control · reports (3001) ·
#   supervisor (launcher `process`, Chromium real de Playwright) · ARTIFACT_STORE=fs · GIT_PROVIDER=local
# El repositorio de tests es un `git init --bare` en $KATALYST_STACK_DIR con el contenido de qa-tests + los tests de la
# fixture local (scripts/dev-stack/qa-tests-local). Secretos de desarrollo aleatorios en $KATALYST_STACK_DIR (0600).
#
# Uso:
#   scripts/dev-stack.sh start      # arranca todo en segundo plano y espera salud
#   scripts/dev-stack.sh stop       # detiene todos los procesos (y ejecutores huérfanos)
#   scripts/dev-stack.sh status     # PIDs y salud
#   scripts/dev-stack.sh env        # imprime el entorno NO secreto (para depurar)
#   scripts/dev-stack.sh rebuild-repo   # rehace el repo bare de tests (nuevo commit)
# Variables (todas opcionales):
#   DATABASE_URL (default postgresql://katalyst:katalyst_dev@localhost:5432/katalyst)
#   REDIS_URL (default redis://localhost:6379/0) · QUEUE_PREFIX (default katalyst-dev)
#   KATALYST_STACK_DIR (default ${TMPDIR:-/tmp}/katalyst-dev-stack) · API_PORT 3000 · REPORTS_PORT 3001
#   FAKE_TESTRAIL_PORT 4010 · FAKE_DELTAX_PORT 4020 · FAKE_TESTRAIL_EXTRA_CASES 600 · FAKE_DELTAX_CANARIES (JSON)
# Después de `start`: `node scripts/seed-dev.ts < archivo-con-clave-admin` (o `pnpm dev:seed`).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="${KATALYST_STACK_DIR:-${TMPDIR:-/tmp}/katalyst-dev-stack}"
STACK_DIR="${STACK_DIR%/}"
DATABASE_URL="${DATABASE_URL:-postgresql://katalyst:katalyst_dev@localhost:5432/katalyst}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"
QUEUE_PREFIX="${QUEUE_PREFIX:-katalyst-dev}"
API_PORT="${API_PORT:-3000}"
REPORTS_PORT="${REPORTS_PORT:-3001}"
FAKE_TESTRAIL_PORT="${FAKE_TESTRAIL_PORT:-4010}"
FAKE_DELTAX_PORT="${FAKE_DELTAX_PORT:-4020}"
LOG_DIR="$STACK_DIR/logs"
PID_DIR="$STACK_DIR/pids"
BARE="$STACK_DIR/qa-tests.git"
SERVICES="fake-testrail fake-deltax api control reports supervisor"

log() { printf '[dev-stack] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

redact_url() { printf '%s' "$1" | sed -E 's#://([^:/@]+):[^@]*@#://\1:***@#'; }

ensure_dirs() {
  mkdir -p "$STACK_DIR" "$LOG_DIR" "$PID_DIR" "$STACK_DIR/artifacts" "$STACK_DIR/health" "$STACK_DIR/runner" "$STACK_DIR/fake-testrail"
  chmod 700 "$STACK_DIR"
}

rand() { node -e "process.stdout.write(require('node:crypto').randomBytes(${1:-24}).toString('base64url'))"; }

# Secretos de desarrollo (aleatorios, nunca en el repo). Formato KEY=VALUE, 0600.
ensure_secrets() {
  local f="$STACK_DIR/secrets.env"
  if [ ! -f "$f" ]; then
    umask 077
    {
      printf 'KATALYST_SECRET__SESSION=%s\n' "$(rand 32)"
      printf 'KATALYST_SECRET__TESTRAIL_FAKE=%s\n' "$(rand 24)"
      printf 'KATALYST_SECRET__QA_LOCAL=%s\n' "Qa-Local-$(rand 18)"
      printf 'KATALYST_SECRET__FS_SIGNING=%s\n' "$(rand 32)"
    } >"$f"
    umask 022
  fi
  chmod 600 "$f"
}

# Configuración NO secreta compartida por api/control/reports/bootstrap (también la lee scripts/seed-dev.ts).
write_stack_env() {
  cat >"$STACK_DIR/stack.env" <<EOF
NODE_ENV=development
LOG_LEVEL=${LOG_LEVEL:-info}
DATABASE_URL=$DATABASE_URL
REDIS_URL=$REDIS_URL
QUEUE_PREFIX=$QUEUE_PREFIX
API_HOST=127.0.0.1
API_PORT=$API_PORT
REPORTS_HOST=127.0.0.1
REPORTS_PORT=$REPORTS_PORT
PUBLIC_BASE_URL=http://localhost:5173
REPORTS_BASE_URL=http://127.0.0.1:$REPORTS_PORT
COOKIE_SECURE=false
SECRET_PROVIDER=env
SESSION_SECRET_REF=env:KATALYST_SECRET__SESSION
ARTIFACT_STORE=fs
ARTIFACT_FS_DIR=$STACK_DIR/artifacts
ARTIFACT_FS_SIGNING_KEY_REF=env:KATALYST_SECRET__FS_SIGNING
GIT_PROVIDER=local
GIT_LOCAL_REPO_PATH=$BARE
GIT_PROTECTED_BRANCH=main
SSRF_ALLOW_LOOPBACK=true
SSRF_ALLOW_HTTP=true
ALLOWED_TARGET_HOSTS=127.0.0.1,localhost
OUTBOX_POLL_MS=${OUTBOX_POLL_MS:-2000}
SCHEDULER_TICK_MS=${SCHEDULER_TICK_MS:-5000}
HEALTH_FILE=$STACK_DIR/health/control
DEFAULT_TIMEZONE=America/La_Paz
KATALYST_STACK_DIR=$STACK_DIR
KATALYST_DEV_API_URL=http://127.0.0.1:$API_PORT
FAKE_TESTRAIL_URL=http://127.0.0.1:$FAKE_TESTRAIL_PORT
FAKE_DELTAX_URL=http://127.0.0.1:$FAKE_DELTAX_PORT
EOF
}

load_env() {
  set -a
  # shellcheck disable=SC1091
  . "$STACK_DIR/stack.env"
  # shellcheck disable=SC1091
  . "$STACK_DIR/secrets.env"
  set +a
}

check_deps() {
  command -v node >/dev/null || die "node no está en PATH (export PATH=/opt/homebrew/opt/node@24/bin:\$PATH)"
  command -v git >/dev/null || die "git no está en PATH"
  command -v pg_isready >/dev/null && { pg_isready -q -d "$DATABASE_URL" || die "PostgreSQL no responde en $(redact_url "$DATABASE_URL")"; }
  command -v redis-cli >/dev/null && { redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1 || die "Redis no responde en $REDIS_URL"; }
  [ -d "$ROOT/apps/api/node_modules" ] || die "faltan dependencias: ejecuta pnpm install"
}

migrate() {
  log "migraciones (prisma migrate deploy) en $(redact_url "$DATABASE_URL")"
  (cd "$ROOT/apps/api" && DATABASE_URL="$DATABASE_URL" node_modules/.bin/prisma migrate deploy >"$LOG_DIR/migrate.log" 2>&1) ||
    die "migrate deploy falló (ver $LOG_DIR/migrate.log)"
}

# Repo bare de tests: qa-tests (sin node_modules ni resultados) + tests de la fixture local + manifiesto ampliado.
build_repo() {
  local work="$STACK_DIR/repo-work"
  rm -rf "$work"
  mkdir -p "$work"
  (cd "$ROOT/qa-tests" && tar --exclude node_modules --exclude test-results --exclude playwright-report --exclude .auth -cf - .) | (cd "$work" && tar -xf -)
  cp -R "$ROOT/scripts/dev-stack/qa-tests-local/tests/." "$work/tests/"
  node -e '
    const fs = require("node:fs");
    const [manifestPath, extraPath] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const extra = JSON.parse(fs.readFileSync(extraPath, "utf8"));
    const keys = new Set(m.tests.map((t) => t.stableKey));
    for (const t of extra) if (!keys.has(t.stableKey)) m.tests.push(t);
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  ' "$work/katalyst.manifest.json" "$ROOT/scripts/dev-stack/qa-tests-local/manifest-local.json"
  [ -d "$BARE" ] || git init --quiet --bare --initial-branch=main "$BARE"
  (
    cd "$work"
    git init --quiet --initial-branch=main .
    git -c user.name="Katalyst dev-stack" -c user.email="dev-stack@example.test" add -A
    git -c user.name="Katalyst dev-stack" -c user.email="dev-stack@example.test" commit --quiet -m "qa-tests + fixture local ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
    git push --quiet --force "$BARE" main:main
  )
  log "repo de tests: $BARE @ $(git --git-dir="$BARE" rev-parse main)"
  rm -rf "$work"
}

# Playwright para los checkouts (KATALYST_CHECKOUT_INSTALL=never): el checkout vive bajo $STACK_DIR/runner y Node
# resuelve @playwright/test subiendo directorios hasta $STACK_DIR/node_modules (enlace a la versión congelada 1.65.0).
link_playwright() {
  local real
  real="$(cd "$ROOT/qa-tests/node_modules/@playwright/test" && pwd -P)"
  mkdir -p "$STACK_DIR/node_modules/@playwright"
  ln -sfn "$real" "$STACK_DIR/node_modules/@playwright/test"
}

ensure_supervisor_token() {
  local f="$STACK_DIR/supervisor.token"
  if [ ! -s "$f" ]; then
    log "emitiendo credencial de servicio del supervisor (bootstrap-admin --service-credential)"
    (umask 077 && cd "$ROOT/apps/api" && node --conditions=source --import tsx src/cli/bootstrap-admin.ts --service-credential supervisor:dev-stack --days 30 >"$f" 2>>"$LOG_DIR/bootstrap.log") ||
      die "no se pudo emitir la credencial del supervisor (ver $LOG_DIR/bootstrap.log)"
  fi
  chmod 600 "$f"
}

is_running() { [ -f "$PID_DIR/$1.pid" ] && kill -0 "$(cat "$PID_DIR/$1.pid")" 2>/dev/null; }

spawn() { # spawn <nombre> <cwd> <comando...>
  local name="$1" cwd="$2"
  shift 2
  if is_running "$name"; then
    log "$name ya está corriendo (pid $(cat "$PID_DIR/$name.pid"))"
    return
  fi
  # `exec` para que el PID registrado sea el del proceso real (no un subshell que retenga la salida del script).
  (cd "$cwd" || exit 1; exec nohup "$@" >>"$LOG_DIR/$name.log" 2>&1 </dev/null) >/dev/null 2>&1 &
  echo $! >"$PID_DIR/$name.pid"
  log "$name iniciado (pid $(cat "$PID_DIR/$name.pid"), log $LOG_DIR/$name.log)"
}

wait_http() { # wait_http <nombre> <url> <segundos>
  local i=0
  until curl -fsS -o /dev/null "$2" 2>/dev/null; do
    i=$((i + 1))
    is_running "$1" || die "$1 terminó al arrancar (ver $LOG_DIR/$1.log)"
    [ "$i" -gt "$(($3 * 2))" ] && die "$1 no respondió en $3 s ($2)"
    sleep 0.5
  done
}

start() {
  ensure_dirs
  check_deps
  ensure_secrets
  write_stack_env
  load_env
  migrate
  [ -d "$BARE" ] || build_repo
  link_playwright
  ensure_supervisor_token

  spawn fake-testrail "$ROOT" env FAKE_TESTRAIL_API_KEY="$KATALYST_SECRET__TESTRAIL_FAKE" FAKE_TESTRAIL_DATA_DIR="$STACK_DIR/fake-testrail" \
    node scripts/fake-testrail.mjs --port "$FAKE_TESTRAIL_PORT"
  spawn fake-deltax "$ROOT" env FAKE_DELTAX_USER="${FAKE_DELTAX_USER:-qa.local@example.test}" node scripts/fake-deltax.mjs --port "$FAKE_DELTAX_PORT"
  wait_http fake-testrail "http://127.0.0.1:$FAKE_TESTRAIL_PORT/_fake/state" 20
  wait_http fake-deltax "http://127.0.0.1:$FAKE_DELTAX_PORT/" 20

  spawn api "$ROOT/apps/api" node --conditions=source --import tsx src/main.api.ts
  spawn reports "$ROOT/apps/api" node --conditions=source --import tsx src/main.reports.ts
  spawn control "$ROOT/apps/api" node --conditions=source --import tsx src/main.control.ts
  wait_http api "http://127.0.0.1:$API_PORT/healthz" 90
  wait_http reports "http://127.0.0.1:$REPORTS_PORT/healthz" 90

  KATALYST_SECRET__SUPERVISOR_TOKEN="$(cat "$STACK_DIR/supervisor.token")" \
  KATALYST_SUPERVISOR_ID=dev-stack \
  KATALYST_API_INTERNAL_URL="http://127.0.0.1:$API_PORT" \
  KATALYST_SUPERVISOR_TOKEN_REF=env:KATALYST_SECRET__SUPERVISOR_TOKEN \
  KATALYST_QUEUE_PREFIX="$QUEUE_PREFIX" \
  KATALYST_EXECUTOR_LAUNCHER=process \
  KATALYST_CHECKOUT_MODE=git \
  KATALYST_TESTS_REPO_URL="file://$BARE" \
  KATALYST_TESTS_PROTECTED_BRANCH=main \
  KATALYST_CHECKOUT_INSTALL=never \
  KATALYST_RUNNER_DATA_DIR="$STACK_DIR/runner/data" \
  KATALYST_SHARD_SECRETS_DIR="$STACK_DIR/runner/shards" \
  KATALYST_HEALTH_FILE="$STACK_DIR/health/supervisor" \
  KATALYST_GLOBAL_BROWSER_CONCURRENCY=1 \
    spawn supervisor "$ROOT/apps/runner" node --conditions=source --import tsx src/main.supervisor.ts
  local i=0
  until grep -q 'supervisor listo' "$LOG_DIR/supervisor.log" 2>/dev/null; do
    i=$((i + 1))
    is_running supervisor || die "supervisor terminó al arrancar (ver $LOG_DIR/supervisor.log)"
    [ "$i" -gt 120 ] && die "supervisor no quedó listo en 60 s"
    sleep 0.5
  done
  log "stack listo: api http://127.0.0.1:$API_PORT · reports http://127.0.0.1:$REPORTS_PORT · TestRail falso http://127.0.0.1:$FAKE_TESTRAIL_PORT · fixture http://127.0.0.1:$FAKE_DELTAX_PORT"
  log "siguiente paso: node scripts/seed-dev.ts < archivo-con-clave-admin   (KATALYST_STACK_DIR=$STACK_DIR)"
}

stop() {
  local name pid
  for name in supervisor control reports api fake-deltax fake-testrail; do
    [ -f "$PID_DIR/$name.pid" ] || continue
    pid="$(cat "$PID_DIR/$name.pid")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
      log "$name detenido (pid $pid)"
    fi
    rm -f "$PID_DIR/$name.pid"
  done
  # Ejecutores/Chromium huérfanos lanzados desde este stack (sus argumentos contienen $STACK_DIR).
  pkill -f "$STACK_DIR/runner" 2>/dev/null || true
}

status() {
  local name
  for name in $SERVICES; do
    if is_running "$name"; then printf '%-14s activo   pid %s\n' "$name" "$(cat "$PID_DIR/$name.pid")"; else printf '%-14s detenido\n' "$name"; fi
  done
  curl -fsS "http://127.0.0.1:$API_PORT/readyz" 2>/dev/null && echo || echo "api /readyz no disponible"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  env) ensure_dirs; write_stack_env; cat "$STACK_DIR/stack.env" ;;
  rebuild-repo) ensure_dirs; build_repo ;;
  *) die "uso: $0 start|stop|restart|status|env|rebuild-repo" ;;
esac
