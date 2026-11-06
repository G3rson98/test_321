#!/usr/bin/env bash
# Katalyst — broker de credenciales temporales del rol del host para servicios Compose CONFIABLES.
# Requisitos: RNF-SEG-05 (contenedores de tests sin metadatos de nube), ESP §13.7, ARQ §4.
#
# IMDSv2 tiene hop limit 1: ningún contenedor en red bridge puede obtener credenciales de IMDS. Este
# script (en el HOST, cada 5 min por katalyst-aws-credentials.timer) obtiene las credenciales temporales
# del rol y las escribe en /run/katalyst/aws (tmpfs, 0440 root:1000) en formato `credential_process`.
# Solo api/control/reports/supervisor/caddy montan ese directorio (solo lectura). Los ejecutores de
# shard NUNCA lo montan. Los SDK refrescan solos al acercarse `Expiration`.
# Nota: la credencial es la del rol completo del host (una EC2 no aísla IAM por contenedor; ARQ §4).
KATALYST_SCRIPT=aws-credential-broker
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd curl jq
load_katalyst_env

OUT=/run/katalyst/aws
install -d -m 0750 -o root -g 1000 "$OUT"
IMDS=http://169.254.169.254

hdr="$(mktemp /run/katalyst/.imds.XXXXXX)"
trap 'rm -f "$hdr"' EXIT

token="$(curl -fsS -X PUT "$IMDS/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 120")" \
  || die "no se pudo obtener token IMDSv2"
# El token va en un archivo de cabeceras (curl -H @archivo), no en argumentos visibles.
printf 'X-aws-ec2-metadata-token: %s\n' "$token" > "$hdr"
unset token

role="$(curl -fsS -H @"$hdr" "$IMDS/latest/meta-data/iam/security-credentials/")" \
  || die "la instancia no tiene rol asociado"
role="${role%%$'\n'*}"

curl -fsS -H @"$hdr" "$IMDS/latest/meta-data/iam/security-credentials/$role" \
  | jq -e '{Version: 1, AccessKeyId: .AccessKeyId, SecretAccessKey: .SecretAccessKey, SessionToken: .Token, Expiration: .Expiration}' \
  | write_secret_file "$OUT/credentials.json" 0 1000 0440 \
  || die "no se pudieron obtener credenciales del rol"

printf '[default]\nregion = %s\ncredential_process = /bin/cat %s/credentials.json\n' "$AWS_REGION" "$OUT" \
  | write_secret_file "$OUT/config" 0 1000 0444

log info "credenciales temporales del rol renovadas"
