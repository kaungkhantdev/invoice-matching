# Invoice matching API (NestJS). The page is a separate project and image (web).
# Usage: see README.md → Docker (alone, or with the page through compose.yaml beside the two projects).

# 1. Build (TypeScript).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# 2. Run: only the built API and the packages it needs.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
# Fonts: SVG invoices and PDFs without their own fonts are drawn as images for Textract and Bedrock.
# Without these, their text comes out as empty boxes. (Liberation = the usual Arial/Helvetica/Times stand-ins.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-liberation fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY data ./data
COPY examples ./examples
COPY samples ./samples
# Uploads and results are kept in output/ (a volume in compose.yaml).
RUN mkdir output && chown node:node output
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
