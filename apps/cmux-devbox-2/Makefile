# Makefile for cmux CLI

VERSION ?= 0.1.0
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

# Auth configuration (set via env or make arguments for production)
STACK_PROJECT_ID ?=
STACK_PUBLISHABLE_CLIENT_KEY ?=
CMUX_API_URL ?=
CONVEX_SITE_URL ?=

AUTH_PKG := github.com/cmux-cli/cmux/internal/auth

LDFLAGS := -s -w \
           -X main.Version=$(VERSION) \
           -X main.Commit=$(COMMIT) \
           -X main.BuildTime=$(BUILD_TIME) \
           -X main.Mode=prod \
           -X '$(AUTH_PKG).ProjectID=$(STACK_PROJECT_ID)' \
           -X '$(AUTH_PKG).PublishableKey=$(STACK_PUBLISHABLE_CLIENT_KEY)' \
           -X '$(AUTH_PKG).CmuxURL=$(CMUX_API_URL)' \
           -X '$(AUTH_PKG).ConvexSiteURL=$(CONVEX_SITE_URL)'

.PHONY: build build-dev clean test install

build:
	go build -ldflags "$(LDFLAGS)" -o bin/cmux ./cmd/cmux

build-dev:
	@echo "Building for development (Mode=dev)..."
	go build -ldflags "-X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildTime=$(BUILD_TIME) -X main.Mode=dev" \
		-o bin/cmux ./cmd/cmux
	@echo "Dev build complete: bin/cmux"

install: build
	cp bin/cmux /usr/local/bin/cmux

install-dev: build-dev
	cp bin/cmux /usr/local/bin/cmux

clean:
	rm -rf bin/

test:
	go test -v ./...

deps:
	go mod download
	go mod tidy

# Build for all platforms
build-all:
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-darwin-amd64 ./cmd/cmux
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-darwin-arm64 ./cmd/cmux
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-linux-amd64 ./cmd/cmux
	GOOS=linux GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-linux-arm64 ./cmd/cmux
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-windows-amd64.exe ./cmd/cmux
