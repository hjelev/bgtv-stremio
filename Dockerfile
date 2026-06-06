FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js scraper.js ./
COPY scripts ./scripts
COPY public ./public

# Download channel images at build time so the container is self-contained
RUN node scripts/download-images.js

EXPOSE 7000

CMD ["node", "index.js"]
