FROM node:24-bookworm-slim AS builder

WORKDIR /app
ENV npm_config_fund=false \
    npm_config_update_notifier=false

# better-sqlite3's GitHub prebuild can be unreachable from a Netbird-managed
# build network. Keep the build reproducible by compiling the native module
# locally when the prebuild download is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests first so dependency installation remains cacheable.
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/adapters/package.json ./packages/adapters/package.json
COPY packages/collector/package.json ./packages/collector/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/egress/package.json ./packages/egress/package.json
COPY packages/intel/package.json ./packages/intel/package.json
COPY packages/storage/package.json ./packages/storage/package.json
RUN npm_config_build_from_source=true npm ci

COPY . .
RUN npm run build
# The runtime stages only receive the pruned production dependency tree.
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS api-runtime

ENV NODE_ENV=production \
    APP_CONFIG_PATH=/app/config/portfolio.yaml \
    SQLITE_PATH=/app/data/invest.sqlite \
    API_BIND_HOST=0.0.0.0 \
    API_PORT=3000

WORKDIR /app
RUN groupadd --system --gid 10001 invest \
    && useradd --system --uid 10001 --gid 10001 --no-create-home invest \
    && mkdir -p /app/config /app/data /app/market-hot \
    && chown -R invest:invest /app

COPY --from=builder --chown=invest:invest /app/package.json ./package.json
COPY --from=builder --chown=invest:invest /app/node_modules ./node_modules
COPY --from=builder --chown=invest:invest /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder --chown=invest:invest /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=invest:invest /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=builder --chown=invest:invest /app/packages/domain/dist ./packages/domain/dist
COPY --from=builder --chown=invest:invest /app/packages/config/package.json ./packages/config/package.json
COPY --from=builder --chown=invest:invest /app/packages/config/dist ./packages/config/dist
COPY --from=builder --chown=invest:invest /app/packages/egress/package.json ./packages/egress/package.json
COPY --from=builder --chown=invest:invest /app/packages/egress/dist ./packages/egress/dist
COPY --from=builder --chown=invest:invest /app/packages/storage/package.json ./packages/storage/package.json
COPY --from=builder --chown=invest:invest /app/packages/storage/dist ./packages/storage/dist
COPY --from=builder --chown=invest:invest /app/packages/storage/schema.sql ./packages/storage/schema.sql
COPY --from=builder --chown=invest:invest /app/scripts/import-elephant-positions.mjs ./scripts/import-elephant-positions.mjs
COPY --from=builder --chown=invest:invest /app/scripts/record-option-expiration.mjs ./scripts/record-option-expiration.mjs
COPY --from=builder --chown=invest:invest /app/scripts/probe-daily-llm.mjs ./scripts/probe-daily-llm.mjs
COPY --from=builder --chown=invest:invest /app/packages/adapters/package.json ./packages/adapters/package.json
COPY --from=builder --chown=invest:invest /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=builder --chown=invest:invest /app/packages/collector/package.json ./packages/collector/package.json
COPY --from=builder --chown=invest:invest /app/packages/collector/dist ./packages/collector/dist
COPY --from=builder --chown=invest:invest /app/packages/intel/package.json ./packages/intel/package.json
COPY --from=builder --chown=invest:invest /app/packages/intel/dist ./packages/intel/dist
COPY --from=builder --chown=invest:invest /app/scripts/import-trade-statements.mjs ./scripts/import-trade-statements.mjs

USER invest
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web-runtime

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=0755 docker/nginx-entrypoint.sh /usr/local/bin/invest-nginx-entrypoint

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/invest-nginx-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
