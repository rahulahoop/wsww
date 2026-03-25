# ── Stage 1: build Vue frontend ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=builder /app/dist ./dist

# Bake proxy list into image at build time
RUN wget -qO ./proxies.txt \
  https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/http.txt \
  || wget -qO ./proxies.txt \
  https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt \
  || echo "" > ./proxies.txt

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3001

CMD ["node", "server/index.js"]
