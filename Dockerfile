FROM node:20-slim

WORKDIR /opt/tv_station/tv_site

# Install curl for healthchecks and ffmpeg for video duration probing
RUN apt-get update && apt-get install -y curl ffmpeg && rm -rf /var/lib/apt/lists/*

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Expose port
EXPOSE 3000

CMD ["npm", "start"]
