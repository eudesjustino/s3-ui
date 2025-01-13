FROM node:18-alpine

WORKDIR /usr/sqs-ui
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
