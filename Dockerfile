FROM node:20-slim

# Install ffmpeg and opus (required for Discord voice)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libopus-dev python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev --legacy-peer-deps

# Copy source
COPY . .

CMD ["node", "index.js"]
