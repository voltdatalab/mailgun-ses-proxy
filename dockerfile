FROM alpine:3.23 AS newsletter-retention-link-helper

RUN apk add --no-cache build-base
COPY scripts/newsletter-retention-linkat.c /src/newsletter-retention-linkat.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror -static \
    /src/newsletter-retention-linkat.c \
    -o /newsletter-retention-linkat

FROM oven/bun:1.3.6-alpine

ENV NODE_ENV=production

# Install openssl for Prisma compatibility in Alpine
USER root
RUN apk add --no-cache openssl

WORKDIR /app

# Ensure correct permissions for the bun user
RUN chown -R bun:bun /app

USER bun

# Copy package files and install dependencies
COPY --chown=bun:bun package.json package-lock.json* bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the application code
COPY --chown=bun:bun . .
COPY --from=newsletter-retention-link-helper \
    /newsletter-retention-linkat \
    /usr/local/libexec/newsletter-retention-linkat

# Run build scripts. The artifact check keeps the explicit, operator-invoked
# orphan reconciler in the same image as the deployed application.
RUN DATABASE_URL=mysql://localhost:3306/dummy \
    NEWSLETTER_RETENTION_LINK_HELPER_PREBUILT=/usr/local/libexec/newsletter-retention-linkat \
    bun run build

# Expose the application port
EXPOSE 3000

# Run the application using bun
CMD ["bun", "run", "start:bun"]
