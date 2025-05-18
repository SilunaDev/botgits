# Use Node.js 20 base image
FROM node:20

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the app
COPY . .

# Expose port (change if needed)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
