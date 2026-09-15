FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Docker builds have no TTY, and recent pnpm refuses `prune` without one unless
# CI is set (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) - not a CI system, just
# the same non-interactive signal pnpm already documents for this case.
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm rebuild
RUN pnpm run build:node
RUN pnpm prune --prod --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
RUN addgroup -S signkit && adduser -S -G signkit signkit
COPY --from=build --chown=signkit:signkit /app/build/node ./build/node
COPY --from=build --chown=signkit:signkit /app/node_modules ./node_modules
COPY --from=build --chown=signkit:signkit /app/package.json ./package.json
# The migration runner (scripts/postgres-migrate.mjs) and migrations/postgres are
# included so the same image also serves as the migrator invocation described in
# docs/deployment.md § Applying PostgreSQL migrations - a separate, short-lived
# `docker run <image> node scripts/postgres-migrate.mjs` using a DDL-capable
# DATABASE_URL, distinct from the long-lived app container's least-privilege one.
# Neither addition changes what the default CMD (the app server) can do.
COPY --from=build --chown=signkit:signkit /app/scripts/postgres-migrate.mjs ./scripts/postgres-migrate.mjs
COPY --from=build --chown=signkit:signkit /app/migrations/postgres ./migrations/postgres
USER signkit
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/v1/system/capabilities || exit 1
CMD ["node", "build/node/index.js"]
