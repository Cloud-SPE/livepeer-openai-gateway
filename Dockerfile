# syntax=docker/dockerfile:1.6

# ------------------------------------------------------------------------------
# deps: install all workspace deps (prod + dev) for the build stage. The root
# package.json declares packages/* as workspaces; npm ci pulls
# @cloudspe/livepeer-openai-gateway-core from the public registry into the
# shared node_modules.
# ------------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/livepeer-openai-gateway/package.json ./packages/livepeer-openai-gateway/
RUN npm ci --ignore-scripts

# ------------------------------------------------------------------------------
# ui: build the frontend workspace members (portal, admin) in one stage. The
# frontend workspace root hoists lit + rxjs so shared and consumers resolve a
# single instance. devDeps stay in this stage; only dist/ outputs ship to
# runtime.
# ------------------------------------------------------------------------------
FROM node:20-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json* ./
COPY frontend/shared/package.json ./shared/
COPY frontend/portal/package.json ./portal/
COPY frontend/admin/package.json ./admin/
RUN npm ci --workspaces --include-workspace-root
COPY frontend/shared ./shared
COPY frontend/portal ./portal
COPY frontend/admin ./admin
RUN npm run build:all

# ------------------------------------------------------------------------------
# build: run tsc per workspace; emit packages/<pkg>/dist/. Prune devDeps so the
# runtime stage copies only prod node_modules.
# ------------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm run build --workspaces
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ------------------------------------------------------------------------------
# runtime: distroless Node 20. Non-root by default. No shell.
#
# The composition root lives in livepeer-openai-gateway; main.js imports
# @cloudspe/livepeer-openai-gateway-core which `npm ci` resolved into
# node_modules/ from the public registry.
# ------------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/livepeer-openai-gateway/package.json ./packages/livepeer-openai-gateway/package.json
COPY --from=build /app/packages/livepeer-openai-gateway/dist ./packages/livepeer-openai-gateway/dist
COPY --from=build /app/packages/livepeer-openai-gateway/migrations ./packages/livepeer-openai-gateway/migrations
COPY --from=ui /ui/portal/dist ./frontend/portal/dist
COPY --from=ui /ui/admin/dist ./frontend/admin/dist
EXPOSE 8080
# Distroless images run as `nonroot` by default (uid 65532).
CMD ["packages/livepeer-openai-gateway/dist/main.js"]
