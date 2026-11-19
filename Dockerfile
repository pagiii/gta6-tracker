FROM node:22-alpine
WORKDIR /app
COPY server.js config.json tests.js README.md ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=7860 NODE_ENV=production
EXPOSE 7860
CMD ["node", "server.js"]
