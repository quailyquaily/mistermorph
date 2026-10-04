# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS console
WORKDIR /src/web/console
RUN npm install --global pnpm@12.3.4
COPY web/console/package.json web/console/pnpm-lock.yaml web/console/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/console/ ./
COPY assets/config/ /src/assets/config/
RUN pnpm build

FROM golang:1.25-alpine AS builder
WORKDIR /src
RUN apk add --no-cache ca-certificates git
COPY go.mod go.sum ./
COPY third_party/ultraviolet/ ./third_party/ultraviolet/
RUN go mod download
COPY . .
COPY --from=console /src/web/console/dist/ ./cmd/mistermorph/consolecmd/static/
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/mistermorph ./cmd/mistermorph

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata aws-cli tar \
  && addgroup -S morph \
  && adduser -S -G morph -h /app morph \
  && mkdir -p /data/state /app \
  && chown -R morph:morph /data /app
COPY --from=builder /out/mistermorph /usr/local/bin/mistermorph
COPY --chmod=755 deploy/cloudflare/start.sh /usr/local/bin/start-mistermorph.sh
COPY deploy/cloudflare/config.example.yaml /app/config.example.yaml
USER morph
WORKDIR /app
ENV MISTER_MORPH_FILE_STATE_DIR=/data/state \
  MISTER_MORPH_FILE_CACHE_DIR=/tmp/mistermorph/cache \
  MISTER_MORPH_LOG_FORMAT=json \
  MISTER_MORPH_TOOLS_BASH_ENABLED=false
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/start-mistermorph.sh"]
