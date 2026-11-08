FROM node:26-alpine

# Refresh base OS packages and force the fixed zlib (ALPINE-CVE-2026-4738).
# Kept in one RUN with an explicit upgrade so the layer rebuilds with the fix
# instead of being reused from cache with the vulnerable package.
RUN apk upgrade --no-cache \
 && apk add --no-cache --upgrade "zlib>=1.4-r0" \
 && rm -rf /var/cache/apk/*

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Dependencies first so the layer is cached across source edits.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

# Run unprivileged; Next may write its image cache at runtime.
RUN chown -R node:node /app
USER node

CMD ["npm", "start"]
