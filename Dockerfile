FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Switch to root to copy files and install dependencies
USER root

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# We skip the Chromium download because it's already provided by the base image
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

RUN npm install

# Copy application source
COPY . .

# Ensure correct permissions for the puppeteer user
RUN chown -R pptruser:pptruser /app

# Revert to non-root user for security
USER pptruser

# Expose API port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
