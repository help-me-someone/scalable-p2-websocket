# Dockerfile
FROM node:18.18.0
WORKDIR /app

COPY . /app

RUN npm install

EXPOSE 5001
CMD npm start