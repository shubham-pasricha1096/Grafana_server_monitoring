# Grafana Server Monitoring & MCP Proxy

A comprehensive monitoring solution that combines a custom Node.js monitoring server with a high-performance Go-based Model Context Protocol (MCP) server for Grafana. This project enables AI assistants to interact directly with Grafana, Prometheus, Loki, and other observability datasources.

## 🚀 Overview

This repository contains two primary components:
1.  **Monitoring Proxy Server:** A Node.js/Express suite for managing Grafana interactions and SRE agent workflows.
2.  **MCP Grafana Server:** A specialized Go implementation of the [Model Context Protocol](https://modelcontextprotocol.io/), allowing LLMs (like Claude and Gemini) to query dashboards, logs, and metrics as native tools.

## ✨ Key Features

- **Multi-Protocol Support:** Integrated support for HTTP, SSE, and MCP transports.
- **Observability Stack:** Deep integration with Prometheus (Metrics), Loki (Logs), ClickHouse, and CloudWatch.
- **SRE Automation:** Includes agent scripts (`mcp_sre_agent.js`) for automated incident response and system health checks.
- **Dashboard Management:** Tools for programmatically creating, searching, and managing Grafana dashboards.
- **Extensible Architecture:** Modular Go-based tools for adding new datasource support easily.

## 📁 Project Structure

```text
.
├── mcp-grafana/          # Go implementation of the MCP server
│   ├── cmd/              # Entry points
│   ├── tools/            # Datasource-specific MCP tools (Prometheus, Loki, etc.)
│   └── testdata/         # Local development & integration test configs
├── server.js             # Core Node.js monitoring proxy
├── mcp_sre_agent.js      # AI-driven SRE automation agent
├── claude_server.js      # Claude-specific integration handler
└── GEMINI.md             # Project-specific technical instructions
```

## 🛠️ Getting Started

### Prerequisites
- [Go](https://golang.org/doc/install) v1.26.1+
- [Node.js](https://nodejs.org/) v18+
- [Docker & Docker Compose](https://docs.docker.com/get-docker/) (for running local test services)

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/shubham-pasricha1096/Grafana_server_monitoring.git
    cd Grafana_server_monitoring
    ```

2.  **Install Node.js dependencies:**
    ```bash
    npm install
    ```

3.  **Build the Go MCP Server:**
    ```bash
    cd mcp-grafana
    make build
    ```

### Running the Services

- **Start Local Test Stack (Grafana/Prometheus/Loki):**
  ```bash
  cd mcp-grafana
  make run-test-services
  ```

- **Run the MCP Server:**
  ```bash
  cd mcp-grafana
  make run
  ```

- **Run the Monitoring Proxy:**
  ```bash
  node server.js
  ```

## 🧪 Testing

The project includes a robust testing suite:
- **Unit Tests:** `make test-unit`
- **Integration Tests:** `make test-integration` (Requires Docker)
- **E2E Tests:** `make test-python-e2e` (Requires Python/UV)

---
