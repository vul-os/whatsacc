GO ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.1.0-dev)
LDFLAGS := -s -w -X main.Version=$(VERSION)

.PHONY: build run test vet fmt check clean

build:
	CGO_ENABLED=0 $(GO) build -ldflags '$(LDFLAGS)' -o bin/gateway ./cmd/gateway

run: build
	./bin/gateway -data ./data

test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

fmt:
	gofmt -l -w .

check: vet test
	@test -z "$$(gofmt -l .)" || (echo 'gofmt needed:' && gofmt -l . && exit 1)

clean:
	rm -rf bin
