FROM node:20-slim AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM caddy:alpine
COPY --from=builder /app/dist /usr/share/caddy
COPY frontend/Caddyfile.prod /etc/caddy/Caddyfile
