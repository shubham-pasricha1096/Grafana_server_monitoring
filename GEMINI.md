# Grafana MCP Server - Project Instructions

This project is a Model Context Protocol (MCP) server for Grafana, allowing AI assistants (like Claude, Gemini, etc.) to interact with Grafana instances and their datasources.

## Project Overview

- **Technologies:** Go (v1.26.1), Model Context Protocol (MCP), Grafana OpenAPI, Prometheus, Loki, ClickHouse, CloudWatch, etc.
- **Core Library:** Uses `github.com/mark3labs/mcp-go` for the MCP protocol implementation.
- **Architecture:** The server acts as a proxy/wrapper around Grafana's API and various datasource clients, exposing them as MCP "tools".

## Building and Running

### Prerequisites
- Go toolchain
- Docker and Docker Compose (for integration tests and local services)
- `uv` (for Python E2E tests)

### Commands
- **Build Binary:** `make build` (outputs to `dist/mcp-grafana`)
- **Run Local Services:** `make run-test-services` (Starts Grafana, Prometheus, Loki, etc. in Docker)
- **Run Server (STDIO):** `make run` (Best for direct client integration)
- **Run Server (SSE):** `make run-sse` (Exposes an HTTP endpoint for SSE transport)
- **Lint Code:** `make lint` (Runs `golangci-lint` and a custom JSONSchema linter)

## Testing Strategy

- **Unit Tests:** `make test-unit` or `make test`. These tests should have no external dependencies and use the `unit` build tag.
- **Integration Tests:** `make test-integration`. Requires local services to be running (`make run-test-services`). Uses the `integration` build tag.
- **E2E Tests:** `make test-python-e2e`. Python-based tests located in the `tests/` directory.
- **Cloud Tests:** `make test-cloud`. Requires a Grafana Cloud instance and a service account token.

## Development Conventions

### Tool Implementation
- Tools are located in `mcp-grafana/tools/`.
- Each tool typically has a `Params` struct with `jsonschema` tags for validation and documentation.
- **JSONSchema Tag Formatting:** In `jsonschema` descriptions, commas MUST be escaped with double backslashes (`\\,`) to prevent truncation by the parser. Use `make lint-jsonschema` to verify.
- **Context Handling:** Use `mcpgrafana.GrafanaClientFromContext(ctx)` to retrieve the Grafana client within a tool's execution.

### Error Handling
- Use `fmt.Errorf("context message: %w", err)` to wrap errors and provide trace information.

### Contributions & Releases
- Follow [Keep a Changelog](https://keepachangelog.com/) for `CHANGELOG.md`.
- Releases are branch-based (`release/vX.Y.Z`).

## Key Directories

- `mcp-grafana/cmd/mcp-grafana/`: Entry point and main logic.
- `mcp-grafana/tools/`: Implementation of individual MCP tools (dashboards, queries, etc.).
- `mcp-grafana/internal/linter/`: Custom linters (e.g., for JSONSchema tags).
- `tests/`: Python E2E test suite.
- `testdata/`: Configuration and seed data for local test services.
