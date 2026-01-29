# Makefile for DBA CLI

VERSION ?= 0.1.0
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

LDFLAGS := -X main.Version=$(VERSION) \
           -X main.Commit=$(COMMIT) \
           -X main.BuildTime=$(BUILD_TIME)

.PHONY: build build-universal clean test install fmt lint

# Detect native architecture
NATIVE_ARCH := $(shell uname -m)
ifeq ($(NATIVE_ARCH),x86_64)
	GOARCH_NATIVE := amd64
else ifeq ($(NATIVE_ARCH),arm64)
	GOARCH_NATIVE := arm64
else
	GOARCH_NATIVE := $(NATIVE_ARCH)
endif

# Prefer toolchain arch for CGO builds (avoid cross-CGO when toolchain != native)
TOOLCHAIN_GOARCH := $(shell go env GOARCH 2>/dev/null || echo "")
ifneq ($(TOOLCHAIN_GOARCH),)
	GOARCH_DEFAULT := $(TOOLCHAIN_GOARCH)
else
	GOARCH_DEFAULT := $(GOARCH_NATIVE)
endif

# Default build - toolchain arch with CGO enabled (required for SQLite)
GOARCH ?= $(GOARCH_DEFAULT)
CGO_ENABLED ?= 1
build:
	CGO_ENABLED=$(CGO_ENABLED) GOARCH=$(GOARCH) go build -ldflags "$(LDFLAGS)" -o bin/dba ./cmd/dba

install: build
	cp bin/dba /usr/local/bin/dba

clean:
	rm -rf bin/

test:
	go test -v ./...

fmt:
	go fmt ./...

lint:
	golangci-lint run

# Download dependencies
deps:
	go mod download
	go mod tidy

# Run the CLI
run: build
	./bin/dba

# Build for all platforms
build-all:
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/dba-darwin-amd64 ./cmd/dba
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/dba-darwin-arm64 ./cmd/dba
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/dba-linux-amd64 ./cmd/dba
	GOOS=linux GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/dba-linux-arm64 ./cmd/dba
