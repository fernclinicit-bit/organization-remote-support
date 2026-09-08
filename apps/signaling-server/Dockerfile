FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/signaling-server/package.json apps/signaling-server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm install
COPY apps/signaling-server apps/signaling-server
COPY packages/protocol packages/protocol
RUN npm run build -w @remote/protocol && npm run build -w @remote/signaling-server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/signaling-server/dist ./apps/signaling-server/dist
EXPOSE 8080
CMD ["node", "apps/signaling-server/dist/server.js"]
