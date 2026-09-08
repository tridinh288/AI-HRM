# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Multi-stage build.
#
# The build stage needs TypeScript, drizzle-kit and the whole dev dependency
# tree; the running container needs none of that. Splitting the two keeps the
# final image small and — more importantly — keeps compilers and build tooling
# out of the thing exposed to the internet.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build

WORKDIR /app

# Dependencies are copied and installed before the source, so editing a source
# file does not invalidate the (slow) install layer in Docker's cache.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

RUN npm run build


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime

# dumb-init reaps zombie processes and forwards SIGTERM properly. Without it,
# Node runs as PID 1, where the default signal handlers do not apply, and the
# graceful shutdown in server.ts never runs on a container stop.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations ship with the image so `drizzle-kit migrate` can run against the
# database at deploy time from exactly the version being deployed.
COPY --from=build /app/drizzle ./drizzle
COPY drizzle.config.ts ./

# Never run as root. The `node` user ships with the official image.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
