FROM node:18-bullseye-slim

# Install FFmpeg (Required for HLS Transcoding)
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install dependencies and TypeScript compiler
RUN npm install
# (Optional) If you want to only install production deps after build:
# RUN npm ci

# Copy the rest of the application
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Expose the port the app runs on
EXPOSE 8765

# Command to run the application
CMD ["npm", "start"]
