# =============================================================================
#  Helpdesk Ticketing System - production image
#
#  Multi-stage: the build stages carry the TypeScript compiler and the native
#  toolchain better-sqlite3 needs; the final image carries neither. The result
#  runs as an unprivileged user with writable state confined to /data.
# =============================================================================

# -----------------------------------------------------------------------------
#  Stage 1 - dependencies (including dev, for the TypeScript build)
#
#  better-sqlite3 is a native module. Its install script fetches a prebuilt
#  binary where one exists and compiles from source otherwise, so the toolchain
#  has to be present and the script must be allowed to run.
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev

# -----------------------------------------------------------------------------
#  Stage 2 - build
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# Compiles to ./dist. Views and public assets are copied into the runtime
# image as-is; they are not part of the TypeScript output.
RUN npm run build

# -----------------------------------------------------------------------------
#  Stage 3 - production dependencies only
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app

RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
 # The compiled .node binary is all that is kept; the sources it was built
 # from are dead weight in the runtime image.
 && find node_modules -name '*.o' -delete \
 && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src

# -----------------------------------------------------------------------------
#  Stage 4 - runtime
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# tini reaps zombies and forwards SIGTERM to node, so the graceful shutdown in
# src/server.ts actually runs when the container is stopped - which matters
# here, because that is where the SQLite write-ahead log is checkpointed.
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/ticketing.sqlite \
    UPLOAD_DIR=/data/uploads \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# The node image ships an unprivileged "node" user (uid 1000). Everything the
# application reads is owned by root and world-readable; nothing in /app needs
# to be writable at runtime.
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build     --chown=root:root /app/dist         ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root views  ./views
COPY --chown=root:root public ./public

# The database, attachments and uploaded branding. Declared as a volume so a
# stray `docker run` without -v still starts; compose.yaml mounts a named
# volume over it.
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

# Liveness only: /healthz allocates nothing and touches no database, so a
# database problem is reported through /readyz (used by the proxy) rather than
# killing an otherwise healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
