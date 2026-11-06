#!/usr/bin/env bash
# Katalyst — smoke test de despliegue: API protegida, aislamiento y worker.
# Requisitos: RNF-SEG-03 (API protegida, HTTPS), RNF-SEG-05 (tests sin IMDS/socket/secretos),
# RNF-OBS-02 (health/readiness), ESP §13.7, ESP §18, ARQ §7 (HTTPS restringido; BD/Redis/SSH/Docker/IMDS
# inaccesibles desde tests), RNF-MAN-02.
#
# Modos:
#   smoke-test.sh --external https://<panel> https://<reportes>   desde un equipo en allowed_cidrs
#   smoke-test.sh --host                                          en el host (sesión SSM, root)
# Opcional (--external): KATALYST_SMOKE_HEADER_FILE=<archivo con "Authorization: Bearer ..."> para
# verificar una lectura autenticada; el token se pasa a curl como archivo de cabeceras, nunca en argumentos.
set -euo pipefail

fail=0
pass() { printf 'OK    %s\n' "$*"; }
bad() { printf 'FALLA %s\n' "$*"; fail=1; }

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" || true; }

external() {
  local panel="$1" reports="$2" code headers
  [[ "$panel" == https://* && "$reports" == https://* ]] || { echo "se requieren URLs https://" >&2; exit 2; }

  code="$(http_code "$panel/healthz")"
  [ "$code" = 200 ] && pass "liveness $panel/healthz" || bad "liveness devolvió $code"

  code="$(http_code "$panel/api/v1/runs")"
  [[ "$code" = 401 || "$code" = 403 ]] && pass "API sin credenciales rechazada ($code)" || bad "API sin credenciales devolvió $code (se esperaba 401/403)"

  for p in /metrics /readyz /api/v1/worker/heartbeat; do
    code="$(http_code -X POST "$panel$p")"
    [ "$code" = 404 ] && pass "ruta interna $p no expuesta" || bad "ruta interna $p devolvió $code"
  done

  headers="$(curl -s -D - -o /dev/null --max-time 15 "$panel/")"
  grep -qi '^strict-transport-security:' <<<"$headers" && pass "HSTS en panel" || bad "falta HSTS en panel"
  grep -qi "^content-security-policy:.*frame-ancestors 'none'" <<<"$headers" && pass "CSP del panel" || bad "falta CSP del panel"

  headers="$(curl -s -D - -o /dev/null --max-time 15 "$reports/")"
  grep -qi "^content-security-policy:.*default-src 'none'" <<<"$headers" && pass "CSP estricta en reportes" || bad "falta CSP estricta en reportes"
  code="$(http_code -X POST "$reports/")"
  [ "$code" = 405 ] && pass "reportes solo lectura" || bad "POST a reportes devolvió $code"

  if [ -n "${KATALYST_SMOKE_HEADER_FILE:-}" ]; then
    code="$(http_code -H @"$KATALYST_SMOKE_HEADER_FILE" "$panel${KATALYST_SMOKE_AUTH_PATH:-/api/v1/environments}")"
    [ "$code" = 200 ] && pass "lectura autenticada" || bad "lectura autenticada devolvió $code"
  fi

  # HTTP plano (80) no debe responder: el security group no lo abre.
  code="$(http_code --max-time 5 "http://${panel#https://}/")"
  [ "$code" = 000 ] && pass "puerto 80 cerrado" || bad "puerto 80 respondió $code"
}

host_checks() {
  local dir; dir="$(dirname "$(readlink -f "$0")")"
  # shellcheck source=lib.sh
  source "$dir/lib.sh"
  set +e
  load_katalyst_env
  load_env_file "$KATALYST_RELEASE_DIR/release.env"

  local svc cid health
  for svc in caddy api control reports supervisor postgres redis; do
    cid="$(service_container "$svc")"
    health="$( [ -n "$cid" ] && docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null )"
    [ "$health" = healthy ] && pass "servicio $svc healthy" || bad "servicio $svc: ${health:-no está en ejecución}"
  done

  cid="$(service_container api)"
  if [ -n "$cid" ]; then
    docker exec "$cid" node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      && pass "readiness (BD y cola) OK" || bad "readiness falló"
  fi

  # Puertos de BD/Redis no publicados en el host.
  if ss -ltnH | awk '{print $4}' | grep -Eq '(:5432|:6379)$'; then bad "PostgreSQL/Redis escuchan en el host"; else pass "PostgreSQL/Redis sin puertos publicados"; fi
  if ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)22$'; then bad "sshd escuchando en 22"; else pass "sin SSH"; fi

  # Solo el supervisor monta el socket Docker.
  local mounts
  for svc in caddy api control reports postgres redis; do
    cid="$(service_container "$svc")"
    [ -n "$cid" ] || continue
    mounts="$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$cid")"
    [[ "$mounts" == *docker.sock* ]] && bad "$svc monta docker.sock" || pass "$svc sin docker.sock"
  done

  # Firewall de runner-net aplicado.
  iptables -C DOCKER-USER -i kt-runner0 -j KATALYST-RUNNER-FWD 2>/dev/null && pass "firewall runner-net activo" || bad "firewall runner-net ausente"

  # Sonda de aislamiento con la imagen del ejecutor y las mismas restricciones que usa el supervisor.
  local pg_ip redis_ip runner_gw
  pg_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "katalyst-db"}}{{.IPAddress}}{{end}}' "$(service_container postgres)" 2>/dev/null)"
  redis_ip="$(docker inspect -f '{{with index .NetworkSettings.Networks "katalyst-queue"}}{{.IPAddress}}{{end}}' "$(service_container redis)" 2>/dev/null)"
  runner_gw="$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' katalyst-runner-net 2>/dev/null)"
  if [ -z "${KATALYST_EXECUTOR_IMAGE:-}" ]; then bad "KATALYST_EXECUTOR_IMAGE no definido"; return; fi

  local probe
  probe="$(docker run --rm --network katalyst-runner-net --user 1000:1000 --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --memory 512m --pids-limit 128 --tmpfs /tmp:size=16m \
    -e PG_IP="$pg_ip" -e REDIS_IP="$redis_ip" -e GW_IP="$runner_gw" --log-driver none \
    --entrypoint node "$KATALYST_EXECUTOR_IMAGE" -e '
const net = require("net"), fs = require("fs");
const tcp = (host, port) => new Promise(r => { const s = net.connect({host, port, timeout: 3000});
  s.on("connect", () => { s.destroy(); r(true); }); s.on("timeout", () => { s.destroy(); r(false); }); s.on("error", () => r(false)); });
const http = async (url, init) => { try { const res = await fetch(url, {...init, signal: AbortSignal.timeout(4000)}); return res.status; } catch { return 0; } };
(async () => {
  const out = {
    imds: await http("http://169.254.169.254/latest/meta-data/"),
    imdsTokenPut: await http("http://169.254.169.254/latest/api/token", {method: "PUT", headers: {"X-aws-ec2-metadata-token-ttl-seconds": "60"}}),
    postgres: process.env.PG_IP ? await tcp(process.env.PG_IP, 5432) : false,
    redis: process.env.REDIS_IP ? await tcp(process.env.REDIS_IP, 6379) : false,
    postgresDns: await tcp("postgres", 5432),
    hostGateway22: process.env.GW_IP ? await tcp(process.env.GW_IP, 22) : false,
    caddyTls: await tcp("worker-gw", 443),
    dockerSock: fs.existsSync("/var/run/docker.sock"),
    awsBroker: fs.existsSync("/run/katalyst/aws"),
    workerGateway: await http("http://worker-gw:8081/api/v1/worker/heartbeat", {method: "POST"}),
    workerGatewayOther: await http("http://worker-gw:8081/api/v1/runs"),
  };
  process.stdout.write(JSON.stringify(out));
})();' 2>/dev/null)"
  if [ -z "$probe" ]; then bad "la sonda de aislamiento no pudo ejecutarse"; return; fi
  echo "sonda: $probe"
  jq -e '.imds == 0 and .imdsTokenPut == 0' <<<"$probe" >/dev/null && pass "IMDS inaccesible desde runner-net" || bad "IMDS accesible desde runner-net"
  jq -e '(.postgres or .redis or .postgresDns) | not' <<<"$probe" >/dev/null && pass "BD/Redis inaccesibles desde runner-net" || bad "BD/Redis accesibles desde runner-net"
  jq -e '.hostGateway22 | not' <<<"$probe" >/dev/null && pass "host inaccesible desde runner-net" || bad "host accesible desde runner-net"
  jq -e '.caddyTls | not' <<<"$probe" >/dev/null && pass "panel (443) inaccesible desde runner-net" || bad "panel accesible desde runner-net"
  jq -e '(.dockerSock or .awsBroker) | not' <<<"$probe" >/dev/null && pass "sin socket Docker ni credenciales AWS" || bad "socket Docker o credenciales visibles"
  jq -e '.workerGateway == 401 or .workerGateway == 403' <<<"$probe" >/dev/null && pass "gateway de worker exige lease" || bad "gateway de worker devolvió $(jq .workerGateway <<<"$probe")"
  jq -e '.workerGatewayOther == 404' <<<"$probe" >/dev/null && pass "gateway de worker solo expone /api/v1/worker" || bad "gateway expone otras rutas"
  set -e
}

case "${1:-}" in
  --external) [ $# -eq 3 ] || { echo "uso: $0 --external https://<panel> https://<reportes>" >&2; exit 2; }; external "$2" "$3" ;;
  --host) host_checks ;;
  *) echo "uso: $0 --external https://<panel> https://<reportes> | --host" >&2; exit 2 ;;
esac

if [ "$fail" -ne 0 ]; then echo "SMOKE TEST: FALLA"; exit 1; fi
echo "SMOKE TEST: OK"
