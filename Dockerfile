# Use official Node.js 18 image
FROM node:18

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all project files
COPY . .

# Install bash for terminal access
RUN apt-get update && apt-get install -y bash

# Puppeteer dependencies (for Chromium headless)
RUN apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libgbm1 \
    libnss3 \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Expose the port if needed (not required for WhatsApp bot)
EXPOSE 3000

# Start the bot
CMD ["node", "index.js"]
