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

FROM oven/bun:1.3.6-alpine

ENV NODE_ENV=production

USER root
RUN apk add --no-cache openssl

WORKDIR /app
RUN chown -R bun:bun /app

USER bun

COPY --chown=bun:bun package.json package-lock.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --chown=bun:bun . .
COPY --from=application-builder --chown=bun:bun /app/.next /app/.next
COPY --from=application-builder --chown=bun:bun /app/dist /app/dist
COPY --from=application-builder --chown=bun:bun /app/lib/generated /app/lib/generated
COPY --from=newsletter-retention-link-helper \
    /newsletter-retention-linkat \
    /usr/local/libexec/newsletter-retention-linkat

EXPOSE 3000

CMD ["bun", "run", "start:bun"]
