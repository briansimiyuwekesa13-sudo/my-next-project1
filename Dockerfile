FROM node:26-alpine
RUN apk upgrade --no-cache
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV PORT=3000
EXPOSE 3000
# next start binds 0.0.0.0 and honors $PORT.
CMD ["npm","start"]
