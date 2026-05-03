# Claude Bridge — Go migration build (migration/go branch).
#
# Targets:
#   make dev        backend (air) + frontend (vite) hot reload concurrently
#   make build      vite build -> embed -> go build (single static binary)
#   make test       go test ./...
#   make contract   OpenAPI contract verifier (record/replay) — wired in S04
#   make lint       golangci-lint run ./...
#   make tools      go install dev toolchain (air, golangci-lint, oapi-codegen)
#   make clean      remove bin/, dist/, web/dist/
#
# Shell snippets are POSIX sh. On Windows, Git Bash is required on PATH;
# CI windows-latest steps set `shell: bash` explicitly. Native cmd.exe
# is not supported as a make shell.

SHELL := bash

GOOS_NAME := $(shell go env GOOS 2>/dev/null || echo unknown)
ifeq ($(GOOS_NAME),windows)
EXE := .exe
else
EXE :=
endif

BIN := bin/bridge$(EXE)
PKG := ./cmd/bridge

.PHONY: dev dev-go dev-web build build-web embed-web build-go test contract lint clean tools

dev:
	$(MAKE) -j 2 dev-go dev-web

dev-go:
	air -c .air.toml

dev-web:
	cd web && pnpm dev

build: build-web embed-web build-go

# Vite output (web/dist/) is consumed by Go embed.FS via the embed-web
# step below. Fails loudly if web/package.json is missing so a stale
# checkout doesn't silently produce an API-only binary.
build-web:
	@if [ ! -f web/package.json ]; then \
		echo "!! web/package.json missing — scaffold the Vite app first"; \
		exit 1; \
	fi
	@echo ">> vite build"
	cd web && pnpm install --frozen-lockfile && pnpm build

# Stage the Vite output into internal/web/dist/ so //go:embed all:dist
# in internal/web/embed.go picks it up at compile time. Tolerates a
# missing web/dist/ (no frontend yet) so `make build-go` alone still
# produces a working API binary — the SPA route just 404s with a
# helpful message until the bundle is staged.
embed-web:
	@if [ -d web/dist ]; then \
		echo ">> stage embed: web/dist -> internal/web/dist"; \
		rm -rf internal/web/dist && cp -r web/dist internal/web/dist; \
	else \
		echo ">> skip embed-web (web/dist not built — API-only binary)"; \
	fi

build-go:
	@mkdir -p bin
	go build -trimpath -o $(BIN) $(PKG)

test:
	go test ./...

# OpenAPI contract verifier — bytewise diff between Go handlers and
# golden files captured from Next. See test/contract/README.md for the
# per-endpoint workflow. Same Verify code path runs under `make test`
# via test/contract/contract_test.go.
contract:
	go run ./cmd/contract verify-all

lint:
	golangci-lint run ./...

clean:
	rm -rf bin dist web/dist
	@# Wipe the embed staging dir but keep .gitkeep so the embed
	@# directive still finds at least one file on a fresh tree.
	@if [ -d internal/web/dist ]; then \
		find internal/web/dist -mindepth 1 ! -name .gitkeep -exec rm -rf {} +; \
	fi

tools:
	go install github.com/air-verse/air@latest
	go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
	go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest
