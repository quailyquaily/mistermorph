# syntax=docker/dockerfile:1.7

FROM golang:1.24-alpine AS builder
WORKDIR /src

RUN apk add --no-cache ca-certificates git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/mistermorph ./cmd/mistermorph

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata \
  && addgroup -S morph \
  && adduser -S -G morph -h /app morph

COPY --from=builder /out/mistermorph /usr/local/bin/mistermorph
COPY deploy/cloudflare/start.sh /usr/local/bin/start-mistermorph.sh
COPY deploy/cloudflare /tmp/cloudflare-deploy

RUN mkdir -p /data/state /data/cache /app \
  && if [ -f /tmp/cloudflare-deploy/config.runtime.yaml ]; then \
       cp /tmp/cloudflare-deploy/config.runtime.yaml /app/config.yaml; \
     elif [ -f /tmp/cloudflare-deploy/config.yaml ]; then \
       cp /tmp/cloudflare-deploy/config.yaml /app/config.yaml; \
     else \
       echo "Missing deploy/cloudflare config: expected config.runtime.yaml or config.yaml" >&2; \
       exit 1; \
     fi \
  && chmod +x /usr/local/bin/start-mistermorph.sh \
  && rm -rf /tmp/cloudflare-deploy \
  && chown -R morph:morph /data /app

USER morph
WORKDIR /app

ENV MISTER_MORPH_FILE_STATE_DIR=/tmp/mistermorph/state \
  MISTER_MORPH_FILE_CACHE_DIR=/tmp/mistermorph/cache \
  MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL=1 \
  MISTER_MORPH_LOG_FORMAT=json \
  MISTER_MORPH_TOOLS_BASH_ENABLED=false

EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/start-mistermorph.sh"]
