# AHS InSight: Node/Express. Coolify builds from this file instead of Nixpacks (Nixpacks re-downloaded
# the Node toolchain after the nightly cache wipe and sometimes hung).
FROM node:22-alpine
WORKDIR /app

# Dependencies first (layer reused unless package files change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
