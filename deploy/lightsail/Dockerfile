# syntax=docker/dockerfile:1.7

FROM golang:1.24-alpine AS builder
WORKDIR /src

RUN apk add --no-cache ca-certificates git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/mistermorph ./cmd/mistermorph

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata aws-cli \
  && addgroup -S morph \
  && adduser -S -G morph -h /app morph

COPY --from=builder /out/mistermorph /usr/local/bin/mistermorph
COPY deploy/lightsail/start.sh /usr/local/bin/start-mistermorph.sh
COPY deploy/lightsail/config.runtime.yaml /app/config.yaml

RUN mkdir -p /data/state /data/state/audit /data/cache /tmp/mistermorph/state /tmp/mistermorph/cache /app \
  && chmod +x /usr/local/bin/start-mistermorph.sh \
  && chown -R morph:morph /data /tmp/mistermorph /app

USER morph
WORKDIR /app

ENV MISTER_MORPH_RUN_MODE=telegram \
  MISTER_MORPH_FILE_STATE_DIR=/tmp/mistermorph/state \
  MISTER_MORPH_FILE_CACHE_DIR=/tmp/mistermorph/cache \
  MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL=1 \
  MISTER_MORPH_LOG_FORMAT=json \
  MISTER_MORPH_TOOLS_BASH_ENABLED=false \
  MISTER_MORPH_TELEGRAM_HEALTH_ENABLED=true \
  MISTER_MORPH_TELEGRAM_HEALTH_BIND=0.0.0.0 \
  MISTER_MORPH_TELEGRAM_HEALTH_PORT=8787

EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/start-mistermorph.sh"]
