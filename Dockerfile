FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build:agent && pnpm build:control-plane && pnpm build:web && pnpm typecheck

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 10001 kapi \
  && useradd --system --uid 10001 --gid kapi --home-dir /app --shell /usr/sbin/nologin kapi
COPY --from=build --chown=kapi:kapi /app/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=build --chown=kapi:kapi /app/apps/agent/dist ./apps/agent/dist
USER kapi
EXPOSE 8787
CMD ["node", "apps/control-plane/dist/api.mjs"]
