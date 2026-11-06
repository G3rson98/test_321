#!/usr/bin/env bash
# Katalyst — materializa en tmpfs los secretos de infraestructura del host desde SSM SecureString.
# Requisitos: RNF-SEG-01, ESP §13.7, §18 ("operar por referencias SSM y cargar valores fuera de Terraform").
#
# Lee SOLO <KATALYST_SSM_PREFIX>/host/postgres_password y <prefijo>/host/redis_password (los secretos de
# aplicación — sesión, TestRail, usuarios de prueba, IA — los lee la app con SecretProvider `ssm`).
# Escribe en /run/katalyst/secrets (tmpfs, se pierde al reiniciar; lo ejecuta katalyst-secrets.service):
#   postgres_password  999:999  0400  (contenedor postgres, POSTGRES_PASSWORD_FILE)
#   redis_acl          999:999  0400  (contenedor redis; contraseña solo como hash SHA-256)
#   database_url       1000:1000 0400 (api/control/reports/migrate, DATABASE_URL_FILE)
#   redis_url          1000:1000 0400 (api/control/supervisor, REDIS_URL_FILE)
# Los valores nunca pasan por argumentos de procesos ni se imprimen.
# Formato requerido de contraseñas: [A-Za-z0-9_-]{32,} (p. ej. `openssl rand -hex 32`), seguras en URLs.
KATALYST_SCRIPT=sync-secrets
source "$(dirname "$(readlink -f "$0")")/lib.sh"
require_cmd aws jq sha256sum
load_katalyst_env
: "${KATALYST_SSM_PREFIX:?}"

OUT=/run/katalyst/secrets
install -d -m 0750 -o root -g root "$OUT"

PG_NAME="$KATALYST_SSM_PREFIX/host/postgres_password"
REDIS_NAME="$KATALYST_SSM_PREFIX/host/redis_password"

json="$(aws ssm get-parameters --with-decryption --output json --names "$PG_NAME" "$REDIS_NAME")" \
  || die "no se pudieron leer los parámetros SSM del host"

invalid="$(printf '%s' "$json" | jq -r '.InvalidParameters | length')"
[ "$invalid" = "0" ] || die "faltan parámetros SSM: $(printf '%s' "$json" | jq -r '.InvalidParameters | join(", ")')"

pg_pw="$(printf '%s' "$json" | jq -r --arg n "$PG_NAME" '.Parameters[] | select(.Name == $n) | .Value')"
redis_pw="$(printf '%s' "$json" | jq -r --arg n "$REDIS_NAME" '.Parameters[] | select(.Name == $n) | .Value')"
unset json

for v in pg_pw redis_pw; do
  [[ "${!v}" =~ ^[A-Za-z0-9_-]{32,}$ ]] || die "el secreto $v no cumple el formato [A-Za-z0-9_-]{32,}"
done

printf '%s' "$pg_pw" | write_secret_file "$OUT/postgres_password" 999 999 0400
printf 'postgresql://katalyst:%s@postgres:5432/katalyst?schema=public\n' "$pg_pw" \
  | write_secret_file "$OUT/database_url" 1000 1000 0400
printf 'redis://katalyst:%s@redis:6379/0\n' "$redis_pw" \
  | write_secret_file "$OUT/redis_url" 1000 1000 0400

redis_hash="$(printf '%s' "$redis_pw" | sha256sum | cut -d' ' -f1)"
{
  echo "user default off"
  echo "user katalyst on #$redis_hash ~* &* +@all -flushall -flushdb -debug -shutdown -module -config -acl"
  echo "user healthcheck on nopass -@all +ping"
} | write_secret_file "$OUT/redis_acl" 999 999 0400

unset pg_pw redis_pw redis_hash
log info "secretos del host materializados en $OUT"
