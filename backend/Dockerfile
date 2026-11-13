# syntax=docker/dockerfile:1

# ---- base: Node + pnpm, unprivileged user owns /app -------------------------
FROM node:22-bookworm-slim AS base
RUN npm install -g pnpm@10.27.0 \
 && mkdir /app && chown node:node /app
WORKDIR /app
USER node

# ---- build: full dependencies, Prisma Client generation, Nest compilation ---
FROM base AS build
COPY --chown=node:node package.json pnpm-lock.yaml prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
# postinstall runs `prisma generate` (needs prisma/ and prisma.config.ts above).
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .
RUN pnpm build

# ---- migrate: one-off task, runs `prisma migrate deploy` and exits ----------
FROM build AS migrate
# Prisma picks the schema-engine variant from the system's OpenSSL; the slim
# image has none, so install it before the engine is downloaded.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
USER node
# The migrate container runs on an internal network with no internet access:
# skip Prisma's update/telemetry check.
ENV CHECKPOINT_DISABLE=1
# Downloads the schema engine for this platform at build time.
RUN ./node_modules/.bin/prisma --version
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ---- runtime: production dependencies + compiled app only -------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3001
COPY --chown=node:node package.json pnpm-lock.yaml ./
# --ignore-scripts: skip postinstall (prisma CLI is a devDependency); the
# generated client is already compiled into dist/.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build --chown=node:node /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/main.js"]
