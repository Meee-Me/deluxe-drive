# Deluxe Drive runs as a small Node server: it stores each account's files,
# keeps public share links, and lets Deluxe Docs sign in over OAuth 2.0 + PKCE.
# There are no dependencies to install: node's own http, fs and crypto do it.
FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

WORKDIR /app

COPY . .

# The files live on this container's own disk. Mount a volume on /data to keep
# them between runs and redeploys (on Cloud Run the disk is fresh each start).
RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server/index.js"]
