# syntax=docker/dockerfile:1
# The Mela API, for production (and `docker compose --profile app` locally).
# Runs as the unprivileged `node` user on tini. The same image applies the
# migrations and seeds the first super admin: `npm run db:deploy` (the
# `migrate` service in the compose files). See docs/deployment.md.

FROM node:24-alpine AS build
WORKDIR /app
# Prisma picks its query engine by the OpenSSL it finds.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate \
    && npm run build \
    && npm run build:seed \
    && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production \
    PORT=3000 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
# Root-owned and read-only to the app user.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
