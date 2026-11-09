# WireBender self-host image: a Nitro build of the app, in public mode.
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
# Scripts are skipped here: the postinstall (`nuxt prepare`) needs the sources, and `pnpm build` runs it anyway.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:24-slim
WORKDIR /app
ENV WIREBENDER_MODE=public \
    WIREBENDER_DATA=/data \
    PORT=3000 \
    NODE_ENV=production
# .output carries its own node_modules, traced by Nitro, with better-sqlite3 and its linux prebuilt binaries
# (no compiler needed). The migrations are read from <cwd>/server/db/migrations (defaultMigrationsDir).
COPY --from=build /src/.output ./.output
COPY --from=build /src/server/db/migrations ./server/db/migrations
# /data is made here and owned by the unprivileged user, so a new named volume inherits that owner.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# Public mode answers only the host named by WIREBENDER_URL, so the check sends that Host.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const u=new URL(process.env.WIREBENDER_URL||'http://localhost');require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health',headers:{host:u.host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]
