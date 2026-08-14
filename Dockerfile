# Self-contained image for ECS / App Runner / EC2 / anything that runs a container.
# Build:  docker build -t leader-archetype-quiz .
# Run:    docker run -p 3000:3000 --env-file .env.production leader-archetype-quiz
#
# Nothing here is host-specific. There is no build-time database access, so the image can
# be built in CI without any secrets; every variable is read at runtime.

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV BUILD_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# The migrator has to travel in the image so the one-off migrate task runs from the very
# same artefact that serves traffic. It cannot simply be copied: `scripts/` is TypeScript,
# `tsx` is a devDependency, and Next inlines `drizzle-orm` into the server chunks rather
# than leaving it in the standalone `node_modules`. So bundle it to a single CommonJS file
# with its dependencies inlined. `pg` stays external — the standalone output does ship it.
# CJS, not ESM: drizzle's migrator and dotenv `require()` internally, which an ESM bundle
# cannot satisfy.
RUN npx esbuild scripts/migrate.ts \
      --bundle --platform=node --format=cjs \
      --outfile=migrate.cjs --external:pg

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never run the app as root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# The standalone output carries only the server and the modules it actually needs.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# Migrations and the frozen inputs travel with the image so a one-off migrate task can
# run from the very same artefact that serves traffic. `drizzle/` must sit at the working
# directory: the migrator resolves `./drizzle/meta/_journal.json` relative to CWD.
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=build --chown=nextjs:nodejs /app/inputs ./inputs
COPY --from=build --chown=nextjs:nodejs /app/migrate.cjs ./migrate.cjs

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
