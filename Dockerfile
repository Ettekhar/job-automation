FROM mcr.microsoft.com/playwright:v1.47.0-noble

WORKDIR /app

# Copy package manifests
COPY package*.json ./

# Install dependencies cleanly
RUN npm ci
RUN npx playwright install chromium

# Copy application files
COPY . .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
