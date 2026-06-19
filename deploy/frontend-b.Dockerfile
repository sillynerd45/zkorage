# zkorage frontend — VARIANT B (UX redesign A/B). Serves the prebuilt dist-b on :4175 with the same
# no-stale-cache serve.json. Built on the host (badge SHA baked in) → this image just serves it.
#   cd frontend && VITE_VARIANT=b npm run build     # -> frontend/dist-b
# Build context = repo ROOT.
FROM node:22-alpine

RUN npm i -g serve@14.2.6

WORKDIR /app
COPY frontend/dist-b ./dist
COPY frontend/serve.json ./serve.json

EXPOSE 4175

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4175/ >/dev/null 2>&1 || exit 1

CMD ["serve", "-c", "serve.json", "-l", "4175"]
