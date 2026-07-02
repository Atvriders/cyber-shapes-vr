# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: build the client (Vite → packages/client/dist)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package*.json ./
COPY packages/client/package*.json packages/client/
COPY packages/shared/package*.json packages/shared/
COPY packages/server/package*.json packages/server/

# Install ALL workspace deps (hoisted)
RUN npm ci

# Copy source
COPY . .

# Build only the client (vite build → packages/client/dist)
RUN npm run -w packages/client build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: nginx static host
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:alpine

# Security: drop nginx default conf to avoid any accidental serving
RUN rm -f /etc/nginx/conf.d/default.conf

# Static assets produced by vite (hashed filenames live under /assets/)
COPY --from=builder /app/packages/client/dist /usr/share/nginx/html

COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx-security-headers.conf /etc/nginx/security-headers.conf

# nginx listens on port 80 inside the container;
# docker-compose maps host 3020 → container 80.
EXPOSE 80
