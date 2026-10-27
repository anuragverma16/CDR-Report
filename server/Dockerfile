# API image: Node 20 plus Chromium (for report images) with the system libraries it needs.
FROM node:20-bookworm-slim

WORKDIR /app

# Dependencies first, so code changes do not reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /root/.npm

COPY . .

ENV NODE_ENV=production \
    PORT=10000 \
    STORAGE_DIR=/var/data/storage

EXPOSE 10000
CMD ["node", "src/index.js"]
