ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app
COPY --chown=node:node package*.json ./

USER node

# Install all dependencies for build (NODE_ENV not set yet)
RUN npm install

# Copy the rest of the source files into the image.
COPY --chown=node:node . .

# Build code
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev

ENV NODE_ENV=production

# Expose the port that the application listens on.
EXPOSE 8080

# Run the application.
CMD ["npm","run","start"]
