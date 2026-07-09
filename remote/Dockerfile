# Build the Svelte panel and run the relay in one image.
# We use a Dockerfile (rather than Railway's auto-builder) for a deterministic
# Node version and a reliable cross-platform install.
FROM node:20-slim
WORKDIR /app

# Install dependencies, including the dev tooling needed to build the panel.
# `npm install` (not `npm ci`) so the Linux-native optional deps for Tailwind's
# oxide engine and Rollup resolve correctly here — npm's cross-platform
# optional-dependency bug otherwise drops them from a lockfile generated on
# another OS ("Cannot find native binding").
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# Build the SPA into dist/.
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
