# zkorage frontend — VARIANT A (UX redesign A/B). Serves the prebuilt dist-a on :4174 with the same
# no-stale-cache serve.json. Built on the host (badge SHA baked in) → this image just serves it.
#   cd frontend && VITE_VARIANT=a npm run build     # -> frontend/dist-a
# Build context = repo ROOT.
FROM node:22-alpine

RUN npm i -g serve@14.2.6

WORKDIR /app
COPY frontend/dist-a ./dist
COPY frontend/serve.json ./serve.json

EXPOSE 4174

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4174/ >/dev/null 2>&1 || exit 1

CMD ["serve", "-c", "serve.json", "-l", "4174"]
