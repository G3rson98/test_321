# syntax=docker/dockerfile:1
# Katalyst — imagen del ejecutor de shard (@katalyst/runner, main.executor.ts) sobre la imagen oficial
# de Playwright. Requisitos: ESP §4 (imagen mcr.microsoft.com/playwright fijada por tag y digest),
# RNF-CON-03, RNF-SEG-05, ESP §13.1 (versiones de runtime en snapshot), §13.3, §13.7, ARQ §3.
#
# PLAYWRIGHT_IMAGE (placeholder, se fija en CI y en release.env):
#   mcr.microsoft.com/playwright:v<PLAYWRIGHT_VERSION>-noble@sha256:<digest>
# <PLAYWRIGHT_VERSION> DEBE coincidir EXACTAMENTE con la versión de @playwright/test fijada en
# apps/runner y qa-tests (plan §2). La construcción falla si no coinciden.
#
#   docker build -f deploy/docker/executor.Dockerfile \
#     --build-arg PLAYWRIGHT_VERSION=1.5x.y \
#     --build-arg PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.5x.y-noble@sha256:<digest> \
#     --build-arg PNPM_VERSION=10.x.y -t <registro>/katalyst-executor:<versión> .
#
# El contenedor se ejecuta SIEMPRE lanzado por el supervisor con: --network katalyst-runner-net,
# --user 1000:1000, --read-only, --cap-drop ALL, no-new-privileges, límites CPU/RAM/PIDs, tmpfs para
# /tmp y /run/katalyst/state (storageState), secretos de la asignación en solo lectura, sin socket
# Docker y sin credenciales AWS (ver deploy/docker-compose.yml, bloque x-katalyst-executor).

ARG PLAYWRIGHT_IMAGE

FROM ${PLAYWRIGHT_IMAGE} AS build
ARG PNPM_VERSION
ARG PLAYWRIGHT_VERSION
RUN test -n "${PNPM_VERSION}" && test -n "${PLAYWRIGHT_VERSION}" \
 || (echo "PNPM_VERSION y PLAYWRIGHT_VERSION son obligatorios" >&2; exit 1)
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/runner apps/runner
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@katalyst/runner..."
RUN pnpm --filter "@katalyst/runner..." run build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter "@katalyst/runner" deploy --prod --legacy /out
# Verificación de compatibilidad: @playwright/test del paquete == versión de la imagen base.
RUN cd /out && node -e "\
const want = process.env.PLAYWRIGHT_VERSION; \
let got = null; \
try { got = require('@playwright/test/package.json').version; } catch { process.exit(0); } \
if (got !== want) { console.error('Playwright ' + got + ' != imagen ' + want); process.exit(1); }"

FROM ${PLAYWRIGHT_IMAGE} AS runtime
ARG PLAYWRIGHT_VERSION
LABEL org.opencontainers.image.title="katalyst-executor" \
      org.opencontainers.image.description="Katalyst ejecutor de shard Playwright (Chromium x86_64)" \
      io.katalyst.playwright.version="${PLAYWRIGHT_VERSION}"
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production \
    HOME=/tmp/home \
    KATALYST_PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION} \
    KATALYST_STATE_DIR=/run/katalyst/state \
    KATALYST_SECRETS_DIR=/run/katalyst/secrets \
    KATALYST_TESTS_DIR=/work/tests \
    KATALYST_OUTPUT_DIR=/work/out
USER 1000:1000
CMD ["node", "dist/main.executor.js"]
