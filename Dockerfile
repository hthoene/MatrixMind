FROM node:20-alpine AS builder

# Native build tools for better-sqlite3 if no prebuild is available
RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Runtime image ---
FROM node:20-alpine

RUN apk add --no-cache bash python3 \
 && ln -sf /usr/bin/python3 /usr/bin/python \
 && addgroup -g 1001 matrixmind \
 && adduser -u 1001 -G matrixmind -s /bin/sh -D matrixmind

ENV SHELL=/bin/bash

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/workspaces && chown matrixmind:matrixmind /app/workspaces

USER matrixmind

EXPOSE 3000
CMD ["node", "dist/index.js"]
