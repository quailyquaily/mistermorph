# syntax=docker/dockerfile:1.7

# The Console (web/console-nsh) as a static site. The nsh CLI is a glibc build, so this stage is
# Debian; nsh's install script downloads the pinned release and checks its .sha256.
FROM node:24-bookworm-slim AS console
ARG NSH_VERSION=v0.4.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/longbridge/nsh/releases/download/${NSH_VERSION}/install.sh" | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /src
COPY assets/config/ ./assets/config/
COPY web/console-nsh/ ./web/console-nsh/
RUN web/console-nsh/scripts/build-web.sh /src/console-dist

FROM golang:1.25-alpine AS builder
WORKDIR /src
RUN apk add --no-cache ca-certificates git
COPY go.mod go.sum ./
COPY third_party/ultraviolet/ ./third_party/ultraviolet/
RUN go mod download
COPY . .
COPY --from=console /src/console-dist/ ./cmd/mistermorph/consolecmd/static/
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
