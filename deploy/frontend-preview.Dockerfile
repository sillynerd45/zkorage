# zkorage frontend — UNIFIED UX redesign preview. Serves the prebuilt unified `dist` on :4174 (the
# existing zkorage-a.wazowsky.id tunnel route) with the same no-stale-cache serve.json. The badge stamp
# (version/git-SHA/build-time) is baked into dist/ on the HOST by `npm run build`, so this image just
# serves it. Replaces the throwaway A/B preview images (frontend-a/-b).
#   cd frontend && npm run build        # host: stamps the unified bundle -> frontend/dist
# Build context = repo ROOT; only frontend/dist + frontend/serve.json are pulled in.
FROM node:22-alpine

RUN npm i -g serve@14.2.6

WORKDIR /app
COPY frontend/dist ./dist
COPY frontend/serve.json ./serve.json

EXPOSE 4174

# serve.json sets: index.html -> no-store; assets/** -> immutable 1y; **->/index.html SPA fallback.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4174/ >/dev/null 2>&1 || exit 1

CMD ["serve", "-c", "serve.json", "-l", "4174"]
