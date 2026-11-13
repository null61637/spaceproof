# syntax=docker/dockerfile:1

# ---- base: unprivileged user owns /app --------------------------------------
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN mkdir /app && chown node:node /app
WORKDIR /app
USER node

# ---- deps -------------------------------------------------------------------
FROM base AS deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM base AS build
# The /api rewrite in next.config.ts is resolved at build time, so the backend
# URL must be known here as well as at runtime.
ARG BACKEND_URL
ENV BACKEND_URL=${BACKEND_URL}
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN npm run build

# ---- runtime: standalone server only ----------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
