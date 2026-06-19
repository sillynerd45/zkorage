# zkorage frontend — serves the PREBUILT production bundle with no-stale-cache headers.
# The badge stamp (version/git-SHA/build-time) is baked into dist/ on the HOST by `npm run build`
# (where git is available), so this image just serves it. Rebuild flow:
#   cd frontend && npm run build        # host: stamps the bundle with the current commit
#   docker compose build frontend && docker compose up -d frontend
# Build context = repo ROOT; only frontend/dist + frontend/serve.json are pulled in.
FROM node:22-alpine

RUN npm i -g serve@14.2.6

WORKDIR /app
COPY frontend/dist ./dist
COPY frontend/serve.json ./serve.json

EXPOSE 4173

# serve.json sets: index.html -> no-store; assets/** -> immutable 1y; **->/index.html SPA fallback.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4173/ >/dev/null 2>&1 || exit 1

CMD ["serve", "-c", "serve.json", "-l", "4173"]
