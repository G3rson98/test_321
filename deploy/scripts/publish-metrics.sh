#!/usr/bin/env bash
# Katalyst — publica métricas propias en CloudWatch (namespace Katalyst, dimensión Environment=internal).
# Requisitos: RNF-OBS-02, RNF-INF-03 (alertas externas), RNF-CON-04 (backup > 26 h), RNF-CON-01, ESP §18, ARQ §6.
# Ejecutado cada 60 s por katalyst-metrics.timer en el HOST.
#
# Métricas:
#   HostHeartbeat              1 en cada ejecución (alarma si falta: host/publicador caído)
#   BackupAgeHours             horas desde el último backup verificado (/data/backups/state/last-success)
#   AppMetricsScrapeOk         1/0 según se pudo leer /metrics de la API
#   OutboxOverdue              suma de katalyst_outbox_overdue
#   QueueOldestWaitingSeconds  máximo de katalyst_queue_oldest_waiting_seconds
#   WorkerLeasesExpired        suma de katalyst_worker_leases_expired_recent (vencidos en los últimos 5 min)
# Contrato con apps/api (pendiente de integración): /metrics en formato Prometheus accesible desde el
# loopback del contenedor api, con esos nombres de serie sin etiquetas de alta cardinalidad.
KATALYST_SCRIPT=publish-metrics
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd aws jq docker
load_katalyst_env

NS="${KATALYST_METRICS_NAMESPACE:-Katalyst}"
STATE_FILE="${KATALYST_DATA_DIR:-/data}/backups/state/last-success"
now="$(date +%s)"

if [ -r "$STATE_FILE" ]; then
  last="$(tr -dc '0-9' < "$STATE_FILE")"
  backup_age="$(awk -v n="$now" -v l="${last:-0}" 'BEGIN { printf "%.2f", (n - l) / 3600 }')"
else
  backup_age="9999"
fi

scrape_ok=0
outbox=""; queue=""; leases=""
api="$(service_container api || true)"
if [ -n "$api" ]; then
  if metrics="$(timeout 15 docker exec "$api" node -e "fetch('http://127.0.0.1:3000/metrics',{signal:AbortSignal.timeout(8000)}).then(async r=>{if(!r.ok)process.exit(2);process.stdout.write(await r.text())}).catch(()=>process.exit(1))" 2>/dev/null)"; then
    scrape_ok=1
    sum_of() { printf '%s\n' "$metrics" | awk -v m="$1" '$1==m || index($1, m"{")==1 { s+=$NF; f=1 } END { if (f) printf "%g", s }'; }
    max_of() { printf '%s\n' "$metrics" | awk -v m="$1" '$1==m || index($1, m"{")==1 { if (!f || $NF>x) x=$NF; f=1 } END { if (f) printf "%g", x }'; }
    outbox="$(sum_of katalyst_outbox_overdue)"
    queue="$(max_of katalyst_queue_oldest_waiting_seconds)"
    leases="$(sum_of katalyst_worker_leases_expired_recent)"
  fi
fi

datum() { # datum <nombre> <valor> <unidad>
  jq -nc --arg n "$1" --arg v "$2" --arg u "$3" \
    '{MetricName:$n, Value:($v|tonumber), Unit:$u, Dimensions:[{Name:"Environment",Value:"internal"}]}'
}

payload="$(mktemp)"
trap 'rm -f "$payload"' EXIT
{
  datum HostHeartbeat 1 Count
  datum BackupAgeHours "$backup_age" None
  datum AppMetricsScrapeOk "$scrape_ok" Count
  [ -n "$outbox" ] && datum OutboxOverdue "$outbox" Count
  [ -n "$queue" ] && datum QueueOldestWaitingSeconds "$queue" Seconds
  [ -n "$leases" ] && datum WorkerLeasesExpired "$leases" Count
  true
} | jq -s . > "$payload"

aws cloudwatch put-metric-data --namespace "$NS" --metric-data "file://$payload" \
  || die "put-metric-data falló"
