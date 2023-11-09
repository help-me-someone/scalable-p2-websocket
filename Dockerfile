# Dockerfile
FROM node:10.15.2

WORKDIR /app

COPY . /app

RUN npm install

EXPOSE 5001
CMD npm start