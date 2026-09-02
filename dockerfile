FROM alpine:3.23 AS newsletter-retention-link-helper

RUN apk add --no-cache build-base
COPY scripts/newsletter-retention-linkat.c /src/newsletter-retention-linkat.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror -static \
    /src/newsletter-retention-linkat.c \
    -o /newsletter-retention-linkat

FROM node:22-alpine AS application-builder

RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
COPY --from=newsletter-retention-link-helper \
    /newsletter-retention-linkat \
    /usr/local/libexec/newsletter-retention-linkat

RUN DATABASE_URL=mysql://localhost:3306/dummy \
    NEWSLETTER_RETENTION_LINK_HELPER_PREBUILT=/usr/local/libexec/newsletter-retention-linkat \
    npm run build

FROM oven/bun:1.3.6-alpine AS bun-runtime

FROM node:22-alpine

ENV NODE_ENV=production

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
COPY --from=application-builder /app/.next /app/.next
COPY --from=application-builder /app/dist /app/dist
COPY --from=application-builder /app/lib/generated /app/lib/generated
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=newsletter-retention-link-helper \
    /newsletter-retention-linkat \
    /usr/local/libexec/newsletter-retention-linkat

# Docker copies this node-owned directory into a newly attached named volume.
# The retention CLI rejects group/other-writable parents, so /tmp is not suitable.
RUN mkdir -p /app/retention && chown -R node:node /app
USER node

EXPOSE 3000

CMD ["npm", "run", "start"]
