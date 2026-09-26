FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY tsconfig.healthcheck.json ./
COPY src ./src
COPY assets/themes ./assets/themes
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=8080 \
    PPTX_OUTPUT_ROOT=/var/lib/marpppt/output \
    TMPDIR=/tmp/marpppt \
    MARPPPT_MAX_REQUEST_BYTES=2097152 \
    MARPPPT_MAX_ACTIVE_REQUESTS=8 \
    MARPPPT_MAX_ACTIVE_JOBS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      fontconfig \
      fonts-noto-cjk \
      libreoffice-impress \
      poppler-utils \
    && groupadd --gid 10001 marpppt \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin marpppt \
    && mkdir -p /var/lib/marpppt/output /tmp/marpppt /home/marpppt/.config/libreoffice \
    && chown -R 10001:10001 /var/lib/marpppt /tmp/marpppt /home/marpppt \
    && chmod 0700 /var/lib/marpppt/output /tmp/marpppt \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/dist-healthcheck ./dist-healthcheck
COPY --from=build --chown=10001:10001 /app/assets/themes ./assets/themes

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD ["node", "/app/dist-healthcheck/healthcheck.js"]
CMD ["node", "dist/mcp/http.js"]
