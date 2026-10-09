FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:node

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000 \
    DATA_DIR=/data \
    MIGRATIONS_DIR=/app/migrations
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/migrations ./migrations
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD node -e "fetch('http://127.0.0.1:3000/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
