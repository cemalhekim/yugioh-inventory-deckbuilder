# Build the SPA, then ship dist/ + the tiny Node server. No runtime npm deps:
# server/ uses only node: builtins and runs as TypeScript via Node's type
# stripping (Node >= 22.18).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    YGO_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY tools ./tools
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "--experimental-strip-types", "--no-warnings", "server/index.ts"]
