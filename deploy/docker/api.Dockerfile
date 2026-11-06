# syntax=docker/dockerfile:1
# Katalyst — imagen de backend (@katalyst/api). Una sola imagen, tres procesos con distinto comando:
#   api      node dist/main.api.js      (HTTP /api/v1, /healthz, /readyz, /metrics)
#   control  node dist/main.control.js  (planificador, reconciliador, outbox, watchdog, limpieza)
#   reports  node dist/main.reports.js  (visor de reportes en origen separado)
#   migrate  node node_modules/prisma/build/index.js migrate deploy
# Requisitos: ESP §4 (stack), §18, ARQ §2/§3, plan §1/§3.
#
# Construcción (contexto = raíz del monorepo; ignora según api.Dockerfile.dockerignore):
#   docker build -f deploy/docker/api.Dockerfile \
#     --build-arg NODE_IMAGE=node:24.x.y-bookworm-slim@sha256:<digest> \
#     --build-arg PNPM_VERSION=10.x.y -t <registro>/katalyst-api:<versión> .
# NODE_IMAGE no tiene valor por defecto a propósito: la versión exacta de Node y su digest se fijan en CI.

ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN test -n "${PNPM_VERSION}" || (echo "PNPM_VERSION es obligatorio" >&2; exit 1)
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@katalyst/api..."
RUN pnpm --filter "@katalyst/api..." run build
# Paquete de producción autocontenido (pnpm 10: deploy sin inject-workspace-packages requiere --legacy).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@katalyst/api" deploy --prod --legacy /out
# Cliente Prisma generado dentro del paquete desplegado (prisma debe ser dependencia de producción).
RUN cd /out && node node_modules/prisma/build/index.js generate

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="katalyst-api" \
      org.opencontainers.image.description="Katalyst backend: api, control, reports, migrate"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Archivos de la aplicación propiedad de root y solo lectura para el usuario de ejecución (uid 1000 = node).
COPY --from=build /out /app
COPY deploy/docker/entrypoint-secrets.sh /usr/local/bin/katalyst-entrypoint
RUN chmod 0555 /usr/local/bin/katalyst-entrypoint
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"
USER 1000:1000
EXPOSE 3000 3001
ENTRYPOINT ["/usr/local/bin/katalyst-entrypoint"]
CMD ["node", "dist/main.api.js"]
