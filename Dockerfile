FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY services ./services
COPY seed ./seed
COPY src ./src
ENV HOST=0.0.0.0 PORT=8791
USER node
EXPOSE 8791
CMD ["npm", "start"]
