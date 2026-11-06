# syntax=docker/dockerfile:1
# Katalyst — imagen del supervisor del host (@katalyst/runner, main.supervisor.ts).
# Requisitos: ESP §13.3 (supervisor, cancelación del árbol de procesos), §13.7, §18, ARQ §2/§4.
#
# El supervisor es el ÚNICO servicio con /var/run/docker.sock. Habla con Docker Engine por su API
# (cliente Node, p. ej. dockerode): la imagen no incluye la CLI de Docker ni herramientas de shell extra.
# Acepta asignaciones tipadas { runId, shardId } de BullMQ, nunca comandos arbitrarios.
#
#   docker build -f deploy/docker/runner.Dockerfile \
#     --build-arg NODE_IMAGE=node:24.x.y-bookworm-slim@sha256:<digest> \
#     --build-arg PNPM_VERSION=10.x.y -t <registro>/katalyst-runner:<versión> .

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
COPY apps/runner/package.json apps/runner/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/runner apps/runner
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@katalyst/runner..."
RUN pnpm --filter "@katalyst/runner..." run build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@katalyst/runner" deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="katalyst-runner" \
      org.opencontainers.image.description="Katalyst supervisor del host"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
COPY deploy/docker/entrypoint-secrets.sh /usr/local/bin/katalyst-entrypoint
RUN chmod 0555 /usr/local/bin/katalyst-entrypoint
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/katalyst-entrypoint"]
CMD ["node", "dist/main.supervisor.js"]
