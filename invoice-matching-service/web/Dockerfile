# Invoice matching page (React). nginx serves it and forwards /api to the API (API_URL).
# Usage: see README.md → Docker (alone, or with the API through compose.yaml beside the two projects).

# 1. Build the page.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2. Serve it.
FROM nginx:stable-alpine
ENV API_URL=http://api:3000
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
