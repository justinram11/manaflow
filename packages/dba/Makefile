# Makefile for DBA CLI

VERSION ?= 0.1.0
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

LDFLAGS := -X main.Version=$(VERSION) \
           -X main.Commit=$(COMMIT) \
           -X main.BuildTime=$(BUILD_TIME)

.PHONY: build clean test install fmt lint run deps

build:
	go build -ldflags "$(LDFLAGS)" -o bin/dba ./cmd/dba

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

deps:
	go mod download
	go mod tidy

run: build
	./bin/dba

# Build for all platforms
build-all:
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/dba-darwin-amd64 ./cmd/dba
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/dba-darwin-arm64 ./cmd/dba
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/dba-linux-amd64 ./cmd/dba
	GOOS=linux GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/dba-linux-arm64 ./cmd/dba
