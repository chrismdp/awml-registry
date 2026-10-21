# The self-hosted registry: the Next.js app with its data in a SQLite file.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
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
