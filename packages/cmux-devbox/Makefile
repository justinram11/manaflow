# Makefile for cmux devbox CLI

VERSION ?= 0.1.0
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

# Strip debug info and disable DWARF for smaller binaries
LDFLAGS := -s -w \
           -X main.Version=$(VERSION) \
           -X main.Commit=$(COMMIT) \
           -X main.BuildTime=$(BUILD_TIME)

.PHONY: build clean test install fmt lint run deps build-all build-npm npm-publish

build:
	go build -ldflags "$(LDFLAGS)" -o bin/cmux-devbox ./cmd/cmux-devbox

install: build
	cp bin/cmux-devbox /usr/local/bin/cmux-devbox

clean:
	rm -rf bin/
	rm -rf npm/*/bin/cmux npm/*/bin/cmux.exe

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
	./bin/cmux-devbox

# Build for all platforms (standalone)
build-all:
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-devbox-darwin-amd64 ./cmd/cmux-devbox
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-devbox-darwin-arm64 ./cmd/cmux-devbox
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-devbox-linux-amd64 ./cmd/cmux-devbox
	GOOS=linux GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-devbox-linux-arm64 ./cmd/cmux-devbox
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/cmux-devbox-windows-amd64.exe ./cmd/cmux-devbox

# Build binaries for npm packages
build-npm:
	@echo "Building npm packages..."
	@mkdir -p npm/darwin-arm64/bin npm/darwin-x64/bin npm/linux-arm64/bin npm/linux-x64/bin npm/win32-x64/bin
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o npm/darwin-arm64/bin/cmux ./cmd/cmux-devbox
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o npm/darwin-x64/bin/cmux ./cmd/cmux-devbox
	GOOS=linux GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o npm/linux-arm64/bin/cmux ./cmd/cmux-devbox
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o npm/linux-x64/bin/cmux ./cmd/cmux-devbox
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o npm/win32-x64/bin/cmux.exe ./cmd/cmux-devbox
	@chmod +x npm/cmux/bin/cmux
	@echo "Done! Binaries built in npm/*/bin/"

# Update version in all npm package.json files
npm-version:
	@echo "Updating npm package versions to $(VERSION)..."
	@for pkg in cmux darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64; do \
		if [ -f "npm/$$pkg/package.json" ]; then \
			sed -i '' 's/"version": "[^"]*"/"version": "$(VERSION)"/' npm/$$pkg/package.json; \
			if [ "$$pkg" = "cmux" ]; then \
				sed -i '' 's/"@cmux\/darwin-arm64": "[^"]*"/"@cmux\/darwin-arm64": "$(VERSION)"/' npm/$$pkg/package.json; \
				sed -i '' 's/"@cmux\/darwin-x64": "[^"]*"/"@cmux\/darwin-x64": "$(VERSION)"/' npm/$$pkg/package.json; \
				sed -i '' 's/"@cmux\/linux-arm64": "[^"]*"/"@cmux\/linux-arm64": "$(VERSION)"/' npm/$$pkg/package.json; \
				sed -i '' 's/"@cmux\/linux-x64": "[^"]*"/"@cmux\/linux-x64": "$(VERSION)"/' npm/$$pkg/package.json; \
				sed -i '' 's/"@cmux\/win32-x64": "[^"]*"/"@cmux\/win32-x64": "$(VERSION)"/' npm/$$pkg/package.json; \
			fi; \
		fi; \
	done
	@echo "Done!"

# Publish to npm (run build-npm first)
npm-publish: build-npm
	@echo "Publishing to npm..."
	@echo "1. Publishing platform packages..."
	cd npm/darwin-arm64 && npm publish --access public
	cd npm/darwin-x64 && npm publish --access public
	cd npm/linux-arm64 && npm publish --access public
	cd npm/linux-x64 && npm publish --access public
	cd npm/win32-x64 && npm publish --access public
	@echo "2. Publishing main package..."
	cd npm/cmux && npm publish --access public
	@echo "Done!"

# Dry-run publish (for testing)
npm-publish-dry: build-npm
	@echo "Dry-run publishing to npm..."
	cd npm/darwin-arm64 && npm publish --access public --dry-run
	cd npm/darwin-x64 && npm publish --access public --dry-run
	cd npm/linux-arm64 && npm publish --access public --dry-run
	cd npm/linux-x64 && npm publish --access public --dry-run
	cd npm/win32-x64 && npm publish --access public --dry-run
	cd npm/cmux && npm publish --access public --dry-run
	@echo "Done!"
