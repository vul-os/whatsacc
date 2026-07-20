# syntax=docker/dockerfile:1
#
# lintel gateway — one static Go binary, one SQLite file.
#
# Build (from repo root):   docker build -t lintel-gateway gateway
# Run:                      docker run -d -p 8080:8080 -v lintel-data:/data \
#                             ghcr.io/vul-os/lintel-gateway:latest
#
# Configuration (flags-over-env, see cmd/gateway/main.go):
#   LINTEL_DATA_DIR    data directory (SQLite db, signing keys)  default /data (set below)
#   LINTEL_LISTEN      listen address                            default :8080
#   LINTEL_PUBLIC_URL  external base URL (webhooks, links)       default ""
#   ADMIN_CLAIM_TOKEN  one-shot admin claim token                default "" (claiming disabled)
#
# The final image is distroless (no shell, no curl/wget). The HEALTHCHECK is a
# tiny stdlib-only Go probe compiled here in the builder stage — it lives in
# this Dockerfile, not in the gateway source tree — that GETs /health on the
# LINTEL_LISTEN port and exits non-zero unless it answers 200.
#
# Data note: /data is baked owned by nonroot (uid 65532). Named volumes inherit
# that ownership; if you bind-mount a host directory instead, chown it to 65532.

FROM golang:1.25-alpine AS build

WORKDIR /src

# Cache module downloads separately from source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.Version=${VERSION}" \
      -o /out/gateway ./cmd/gateway

# Health probe: stdlib-only, kept out of the gateway module on purpose.
RUN mkdir -p /probe && cat > /probe/main.go <<'EOF'
package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	addr := os.Getenv("LINTEL_LISTEN")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Get("http://" + addr + "/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthprobe:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "healthprobe: status", resp.Status)
		os.Exit(1)
	}
}
EOF
RUN cd /probe && go mod init healthprobe >/dev/null \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/healthprobe .

# Pre-create /data with the runtime uid so the volume is writable by nonroot.
RUN mkdir -p /out/data && chown 65532:65532 /out/data

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/gateway /gateway
COPY --from=build /out/healthprobe /healthprobe
COPY --from=build --chown=65532:65532 /out/data /data

ENV LINTEL_DATA_DIR=/data \
    LINTEL_LISTEN=:8080

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/healthprobe"]

USER nonroot
ENTRYPOINT ["/gateway"]
