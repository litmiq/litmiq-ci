# Changelog

## 1.0.0 — 20 November 2026

- CLI `litmiq-ci.mjs`: run a Litmiq suite, compare a baseline, write results, optional Slack-compatible regression webhook. `--validate` and `--help` added.
- GitHub Action `litmiq/litmiq-ci@v1` wraps the same CLI.
- MCP stdio server (`mcp/server.mjs`) with `validate_suite`, `run_suite`, and `read_results`.
- Offline tests only; no provider calls in CI for this repository.
