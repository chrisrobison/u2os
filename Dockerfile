# U2OS Dockerfile. Per docs/deployment.md §1.
#
# Single stage -- no build step exists in this codebase (Phase 1's core
# philosophy: few dependencies, no bundler/transpiler), so a multi-stage
# build would add complexity for nothing.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached across code-only
# changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code.
COPY server/ ./server/
COPY public/ ./public/
COPY skills/ ./skills/

# Local-first data directory (see docs/architecture.md's "Local-first data
# directory" section) -- inside the container this is a mounted volume,
# see docker-compose.yml.
ENV U2OS_HOME=/data
ENV NODE_ENV=production

# SECURITY (least privilege, PROMPT.md §17): don't run the process as root
# inside the container just because that's the image default. node:22-slim
# already ships an unprivileged `node` user (uid 1000) for exactly this.
# Pre-create /data and hand it to that user *before* switching to it --
# Docker seeds a fresh named volume's initial contents/permissions from
# whatever already exists at the mount point in the image at the moment the
# volume is first attached, so this is what makes the /data volume declared
# in docker-compose.yml actually writable by the non-root process rather
# than needing a root-owned entrypoint/chown step at every container start.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4000

CMD ["node", "server/index.js"]
