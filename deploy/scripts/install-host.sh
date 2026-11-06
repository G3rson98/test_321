#!/usr/bin/env bash
# Katalyst — instala/actualiza la integración del host (systemd, logrotate) desde la versión actual.
# Requisitos: RNF-MAN-02 (instalación reproducible), RNF-INF-03, ESP §18 (despliegue de aplicación
# separado de Terraform, sin remote-exec), ARQ §5.
# Idempotente. Ejecutar como root en el host (sesión SSM) después de colocar una versión en
# /opt/katalyst/releases/<versión> y apuntar /opt/katalyst/current (deploy.sh lo hace).
KATALYST_SCRIPT=install-host
source "$(dirname "$(readlink -f "$0")")/lib.sh"
[ "$(id -u)" -eq 0 ] || die "ejecutar como root"
require_cmd systemctl docker install

SRC="$(readlink -f "$KATALYST_RELEASE_DIR")/deploy"
[ -d "$SRC/host/systemd" ] || die "no existe $SRC/host/systemd"
[ -r /etc/katalyst/infra.env ] || die "falta /etc/katalyst/infra.env (user-data de Terraform)"
[ -r /etc/katalyst/site.env ] || die "falta /etc/katalyst/site.env (copiar deploy/site.env.example y completar)"
mountpoint -q /data || die "/data no está montado"
docker compose version >/dev/null 2>&1 || die "plugin docker compose no instalado"

install -d -m 0750 /var/log/katalyst /var/lib/logrotate
chmod 0755 "$SRC"/scripts/*.sh
install -m 0644 "$SRC"/host/systemd/*.service "$SRC"/host/systemd/*.timer /etc/systemd/system/
install -m 0644 "$SRC/host/logrotate-katalyst" /etc/logrotate.d/katalyst
systemctl daemon-reload

systemctl enable --now katalyst-aws-credentials.timer
systemctl start katalyst-aws-credentials.service
systemctl enable katalyst-secrets.service katalyst-runner-firewall.service katalyst.service
systemctl restart katalyst-secrets.service katalyst-runner-firewall.service
systemctl enable --now katalyst-metrics.timer katalyst-backup.timer katalyst-cleanup.timer katalyst-logrotate.timer

log info "integración del host instalada; iniciar con: systemctl start katalyst.service"
