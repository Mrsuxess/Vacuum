# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Build Next.js production bundle
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production runner with native node:sqlite and persistent /app/data directory
FROM base AS runner
WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.mjs ./next.config.mjs

RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV DATABASE_PATH="/app/data/vacuum.db"

CMD ["npm", "run", "start"]
