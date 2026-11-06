# syntax=docker/dockerfile:1
# Katalyst — imagen de Caddy con el plugin DNS-01 y el build estático del panel (@katalyst/web).
# Requisitos: RNF-SEG-03, ESP §13.7, §17 (SPA, carga diferida), §18 (assets de SPA en el host, sin CDN),
# ARQ §3 (Docker Compose + Caddy).
#
# Plugin DNS documentado: github.com/caddy-dns/route53 (libdns/route53), compilado con xcaddy.
# Versiones (PENDIENTE fijar en CI y release.env; tags + digest, sin latest):
#   NODE_IMAGE           node:24.x.y-bookworm-slim@sha256:<digest>
#   CADDY_BUILDER_IMAGE  caddy:2.x.y-builder@sha256:<digest>
#   CADDY_IMAGE          caddy:2.x.y-alpine@sha256:<digest>   (misma 2.x.y que el builder)
#   CADDY_DNS_PLUGIN     github.com/caddy-dns/route53@v1.x.y
#
#   docker build -f deploy/docker/web.Dockerfile --build-arg NODE_IMAGE=... --build-arg PNPM_VERSION=... \
#     --build-arg CADDY_BUILDER_IMAGE=... --build-arg CADDY_IMAGE=... --build-arg CADDY_DNS_PLUGIN=... \
#     -t <registro>/katalyst-web:<versión> .

ARG NODE_IMAGE
ARG CADDY_BUILDER_IMAGE
ARG CADDY_IMAGE

FROM ${NODE_IMAGE} AS spa
ARG PNPM_VERSION
RUN test -n "${PNPM_VERSION}" || (echo "PNPM_VERSION es obligatorio" >&2; exit 1)
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g "pnpm@${PNPM_VERSION}"
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@katalyst/web..."
RUN pnpm --filter "@katalyst/web..." run build
# Sin source maps públicos en el origen del panel.
RUN find apps/web/dist -name '*.map' -type f -delete

FROM ${CADDY_BUILDER_IMAGE} AS caddy-build
ARG CADDY_DNS_PLUGIN
RUN test -n "${CADDY_DNS_PLUGIN}" || (echo "CADDY_DNS_PLUGIN es obligatorio" >&2; exit 1)
RUN xcaddy build --with "${CADDY_DNS_PLUGIN}"

FROM ${CADDY_IMAGE} AS runtime
LABEL org.opencontainers.image.title="katalyst-web" \
      org.opencontainers.image.description="Katalyst Caddy + SPA del panel"
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=spa /repo/apps/web/dist /srv/panel
# Falla la construcción si el plugin DNS no quedó compilado.
RUN caddy list-modules | grep -q '^dns.providers.route53$'
EXPOSE 443 8081
