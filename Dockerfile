FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
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
USER signkit
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/v1/system/capabilities || exit 1
CMD ["node", "build/node/index.js"]
