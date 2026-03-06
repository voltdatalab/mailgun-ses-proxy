ARG NODE_VERSION=20

# ---- Build stage ----
FROM node:${NODE_VERSION}-alpine AS builder

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app
COPY --chown=node:node package*.json ./

USER node

# Install ALL dependencies (including devDependencies) for the build
RUN npm install

# Copy source and build
COPY --chown=node:node . .
RUN npm run build

# ---- Production stage ----
FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV=production

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

USER node

# Copy package files and install production-only dependencies
COPY --chown=node:node --from=builder /home/node/app/package*.json ./
RUN npm install --omit=dev

# Copy build artifacts
COPY --chown=node:node --from=builder /home/node/app/.next ./.next
COPY --chown=node:node --from=builder /home/node/app/dist ./dist
COPY --chown=node:node --from=builder /home/node/app/prisma ./prisma
COPY --chown=node:node --from=builder /home/node/app/lib ./lib
COPY --chown=node:node --from=builder /home/node/app/app ./app
COPY --chown=node:node --from=builder /home/node/app/next.config.ts ./next.config.ts

# Re-generate Prisma client for production (correct binary for alpine)
RUN npx prisma generate

EXPOSE 8080

CMD ["npm","run","start"]
