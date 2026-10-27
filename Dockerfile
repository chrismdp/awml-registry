# The self-hosted registry: the Next.js app with its data in a SQLite file.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# git fetches AWML's source for the engine's build (see below).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
# The AWML engine, built from the commit vendor/awml/version.json pins, with the
# Go release AWML's go.mod names (issue #73). It is its own layer, so it is
# built again only when the pin or the build changes.
COPY scripts/engine-build.sh scripts/engine-lib.sh scripts/engine-go.mjs scripts/
COPY vendor/awml vendor/awml
RUN npm run engine:build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/registry.db
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/vendor/awml ./vendor/awml
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# The app applies any new migrations to the SQLite file when it first opens it.
CMD ["node", "server.js"]
