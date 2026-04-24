# syntax=docker/dockerfile:1.6

# ------------------------------------------------------------------------------
# deps: install all deps (prod + dev) for the build stage.
# ------------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

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
EXPOSE 8080
# Distroless images run as `nonroot` by default (uid 65532).
CMD ["dist/main.js"]
