# Low-RAM image for the WhatsApp link-bot.
# Uses Debian's system chromium instead of Puppeteer's bundled full Chrome,
# which is what keeps this under the 1GB Railway plan.
FROM node:20-slim

WORKDIR /app

# Debian's chromium package. apt pulls in all of chromium's own shared-library
# dependencies automatically, so we don't hand-list libnss3/libgbm1/etc. — that
# avoids breakage when Debian renames packages between releases. We add fonts so
# the QR / text renders, and ca-certificates for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium and skip its own download.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    MEM_TAG=optimized

# Install dependencies (no Chrome download thanks to the env var above).
COPY package*.json ./
RUN npm install

# Copy the rest of the app.
COPY . .

# Cap the Node heap; Chromium gets the rest of the 1GB.
CMD ["node", "--no-deprecation", "--max-old-space-size=256", "index.js"]
