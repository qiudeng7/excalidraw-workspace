FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.24.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:node

FROM build AS migrations
RUN chown -R node:node /app/.nuxt /app/.data /app/node_modules/@nuxthub
USER node
CMD ["sh", "-c", "umask 077; exec pnpm db:migrate"]

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000
COPY --from=build --chown=node:node /app/.output ./.output
RUN mkdir -p /app/.data/db /app/.data/blob && chown -R node:node /app/.data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD node -e "fetch('http://127.0.0.1:3000/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "umask 077; exec node .output/server/index.mjs"]
