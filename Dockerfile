# syntax=docker/dockerfile:1.7
# NHP-BACKEND — pnpm monorepo, apps/api runs via tsx (no separate build step).

FROM node:20-alpine AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:/root/.local/share/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate
RUN apk add --no-cache libc6-compat openssl bash
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/api ./apps/api
# Prisma client generation — runtime needs .prisma/client
RUN pnpm --filter @nhp/api generate

FROM node:20-alpine AS runtime
RUN apk add --no-cache libc6-compat openssl tini
WORKDIR /app
ENV NODE_ENV=production PATH=/pnpm:/root/.local/share/pnpm:$PATH
# tini for correct signal handling — Fastify shutdown is graceful only if it gets SIGTERM.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./

# Bring pnpm into the runtime image so `pnpm --filter @nhp/api serve` works.
RUN corepack enable && corepack prepare pnpm@10 --activate

USER node
EXPOSE 4400
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@nhp/api", "serve"]
