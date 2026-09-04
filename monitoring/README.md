# Larkbot Monitoring

This directory provides an optional Prometheus + Grafana stack for larkbot runtime monitoring.

## Endpoints

- Larkbot console: `http://127.0.0.1:8787`

- Prometheus scrape endpoint: `http://127.0.0.1:8787/metrics`

- Local runtime fallback page: `http://127.0.0.1:8787/runtime`

- Prometheus UI: `http://127.0.0.1:9090`

- Grafana UI: `http://127.0.0.1:3000`

## Start

```bash
cd monitoring
docker compose up -d
```

Grafana default login:

- user: `admin`

- password: `admin`

The dashboard is provisioned as `Larkbot / Larkbot Runtime`.

## Notes

- Prometheus retention is configured to 15 days.

- Prometheus and Grafana use host networking so Prometheus can scrape larkbot on `127.0.0.1:8787/metrics` without changing the console bind address.

- The monitoring stack is optional and reads larkbot metrics passively. It does not enter the message handling path.
