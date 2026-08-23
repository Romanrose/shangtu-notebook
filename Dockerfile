FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server

USER node
CMD ["node", "server/notebook-server.mjs"]
