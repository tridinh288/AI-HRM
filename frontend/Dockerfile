# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# The frontend is a static bundle, so the runtime image is just a web server.
# Node is needed to build it and not to serve it.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

# Vite inlines env vars prefixed with VITE_ at build time, so the API URL is
# baked into the bundle here rather than read at runtime.
ARG VITE_API_URL=http://localhost:4000/api/v1
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build


FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
