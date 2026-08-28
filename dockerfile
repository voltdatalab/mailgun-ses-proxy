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

# Run build scripts. The artifact check keeps the explicit, operator-invoked
# orphan reconciler in the same image as the deployed application.
RUN DATABASE_URL=mysql://localhost:3306/dummy bun run build

# Expose the application port
EXPOSE 3000

# Run the application using bun
CMD ["bun", "run", "start:bun"]
