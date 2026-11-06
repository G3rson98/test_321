#!/usr/bin/env bash
# Katalyst — firewall de la red de ejecutores de tests (katalyst-runner-net, bridge kt-runner0).
# Requisitos: RNF-SEG-05 (sin metadatos de nube, socket Docker ni secretos del backend), ESP §13.7
# (bloquear metadatos, loopback y redes internas no autorizadas), ESP §18, ARQ §4/§7.
#
# Defensa en profundidad sobre IMDSv2 hop limit 1 y redes Compose `internal`:
#  FORWARD (vía cadena DOCKER-USER, que Docker nunca vacía) para tráfico que ENTRA por kt-runner0:
#   1. conexiones establecidas/relacionadas: permitidas (respuestas)
#   2. ejecutor -> gateway de worker (Caddy, <KATALYST_WORKER_GW_IP>:8081/tcp): permitido
#   3. cualquier otro tráfico dentro de kt-runner0 (ejecutor<->ejecutor, caddy:443): bloqueado
#   4. 169.254.0.0/16 (IMDS 169.254.169.254, credenciales ECS 169.254.170.2, link-local): bloqueado
#   5. excepciones privadas explícitas (RUNNER_PRIVATE_ALLOW_CIDRS, p. ej. staging privado registrado)
#   6. 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, 0/8, 224/4: bloqueado (VPC, redes Docker db/queue/edge)
#   7. resto (Internet: destinos DeltaX autorizados): permitido; el SG limita puertos de salida
#  INPUT para tráfico desde kt-runner0 hacia el propio host (gateway del bridge, IP de la ENI, dockerd):
#   solo respuestas establecidas; todo lo demás bloqueado. El DNS embebido de Docker (127.0.0.11) se
#   atiende dentro del namespace del contenedor y no pasa por INPUT.
# Idempotente. Se ejecuta con katalyst-runner-firewall.service después de docker.service.
# IPv6 no está habilitado en las redes Docker de Katalyst; si se habilita, replicar con ip6tables
# (incluido fd00:ec2::254).
KATALYST_SCRIPT=runner-net-firewall
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd iptables
load_katalyst_env

IFACE="${KATALYST_RUNNER_BRIDGE:-kt-runner0}"
GW_IP="${KATALYST_WORKER_GW_IP:-172.30.2.10}"
GW_PORT="${KATALYST_WORKER_GW_PORT:-8081}"
ALLOW="${RUNNER_PRIVATE_ALLOW_CIDRS:-}"
FWD=KATALYST-RUNNER-FWD
INP=KATALYST-RUNNER-IN

ensure_chain() {
  iptables -N "$1" 2>/dev/null || true
  iptables -F "$1"
}

ensure_jump() { # ensure_jump <cadena-padre> <cadena-destino>
  iptables -C "$1" -i "$IFACE" -j "$2" 2>/dev/null || iptables -I "$1" 1 -i "$IFACE" -j "$2"
}

# Docker crea DOCKER-USER al arrancar; si aún no existe, crearla y saltar desde FORWARD.
if ! iptables -L DOCKER-USER -n >/dev/null 2>&1; then
  iptables -N DOCKER-USER
  iptables -C FORWARD -j DOCKER-USER 2>/dev/null || iptables -I FORWARD 1 -j DOCKER-USER
fi

ensure_chain "$FWD"
iptables -A "$FWD" -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
iptables -A "$FWD" -o "$IFACE" -d "$GW_IP" -p tcp --dport "$GW_PORT" -j RETURN
iptables -A "$FWD" -o "$IFACE" -j DROP
iptables -A "$FWD" -d 169.254.0.0/16 -j DROP
for cidr in $ALLOW; do
  [[ "$cidr" =~ ^[0-9.]+/[0-9]+$ ]] || die "CIDR inválido en RUNNER_PRIVATE_ALLOW_CIDRS: $cidr"
  iptables -A "$FWD" -d "$cidr" -j RETURN
  log warn "excepción privada permitida para ejecutores: $cidr (debe estar registrada en docs/decisiones.md)"
done
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4; do
  iptables -A "$FWD" -d "$cidr" -j DROP
done
iptables -A "$FWD" -j RETURN
ensure_jump DOCKER-USER "$FWD"

ensure_chain "$INP"
iptables -A "$INP" -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
iptables -A "$INP" -j DROP
ensure_jump INPUT "$INP"

log info "firewall de $IFACE aplicado (gateway $GW_IP:$GW_PORT)"
