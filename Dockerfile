FROM node:26-alpine

# Refresh base OS packages with the distributor's fixed versions.
RUN apk upgrade --no-cache

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
