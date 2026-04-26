# syntax=docker/dockerfile:1.6

# ------------------------------------------------------------------------------
# deps: install all deps (prod + dev) for the build stage.
# ------------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ------------------------------------------------------------------------------
# ui: build all bridge-ui workspace members (portal, admin) in one stage. The
# workspace root hoists lit + rxjs so shared and consumers resolve a single
# instance. devDeps stay in this stage; only dist/ outputs ship to runtime.
# ------------------------------------------------------------------------------
FROM node:20-alpine AS ui
WORKDIR /ui
# Copy manifests first to maximize cache hits on npm ci.
COPY bridge-ui/package.json bridge-ui/package-lock.json* ./
COPY bridge-ui/shared/package.json ./shared/
COPY bridge-ui/portal/package.json ./portal/
COPY bridge-ui/admin/package.json ./admin/
RUN npm ci --workspaces --include-workspace-root
COPY bridge-ui/shared ./shared
COPY bridge-ui/portal ./portal
COPY bridge-ui/admin ./admin
RUN npm run build:all

# ------------------------------------------------------------------------------
# build: run tsc; prune dev deps so the runtime copies only prod node_modules.
# ------------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npx tsc -p tsconfig.json
RUN npm prune --omit=dev

# ------------------------------------------------------------------------------
# runtime: distroless Node 20. Non-root by default. No shell.
# ------------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json
COPY --from=ui /ui/portal/dist ./bridge-ui/portal/dist
COPY --from=ui /ui/admin/dist ./bridge-ui/admin/dist
EXPOSE 8080
# Distroless images run as `nonroot` by default (uid 65532).
CMD ["dist/main.js"]
