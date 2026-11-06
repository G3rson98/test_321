#!/bin/sh
# Katalyst — entrypoint de las imágenes Node (api/control/reports/supervisor/migrate).
# Requisitos: RNF-SEG-01, ESP §13.7 ("no poner tokens en URL, shell, nombres de archivos ni argumentos
# visibles de procesos").
#
# Convierte variables <NOMBRE>_FILE de una lista permitida en <NOMBRE>, leyendo el archivo de secreto
# montado por Compose (/run/secrets/*). El valor queda solo en el entorno del proceso (no en `docker
# inspect`, ni en argumentos, ni en logs). Si la aplicación ya soporta *_FILE de forma nativa, este paso
# es inocuo.
set -eu

for name in DATABASE_URL REDIS_URL; do
  file_var="${name}_FILE"
  eval "file_path=\${$file_var:-}"
  if [ -n "$file_path" ]; then
    if [ ! -r "$file_path" ]; then
      echo "katalyst-entrypoint: no se puede leer el secreto requerido por $file_var" >&2
      exit 64
    fi
    eval "current=\${$name:-}"
    if [ -n "$current" ]; then
      echo "katalyst-entrypoint: $name y $file_var definidos a la vez; use solo $file_var" >&2
      exit 64
    fi
    value="$(cat "$file_path")"
    export "$name=$value"
    unset value
  fi
done

mkdir -p /tmp/health 2>/dev/null || true

exec "$@"
