# Changelog

## 1.2.0 — 23 November 2026

- Compliance evidence records: `--evidence file` (Action input `evidence`, default `litmiq-evidence.json`, output `evidence`) writes a SHA-256 hashed `litmiq-compliance-evidence-file` record with prompt-version hashes (suite, system prompt, scoring criteria), git context (commit, PR head SHA, ref, run URL, actor), gate verdict, thresholds, missed thresholds, baseline hash, whether a new baseline was written, and approved PR reviews at run time (`null` when unknown).
- `--verify-evidence file` recomputes the hash for CI records and for packs downloaded from the Litmiq app. Exit 0 match, 1 mismatch, 2 not an evidence file.
- The PR comment and step summary show the evidence file and its SHA-256.

## 1.1.0 — 20 November 2026

- Per-metric thresholds: `suite.ci.max_metric_drop`, `max_metric_drops`, `min_metrics`, and `min_pass_rate`, plus CLI flags `--max-avg-drop`, `--max-pass-rate-drop`, `--min-avg`, `--min-pass-rate`, `--max-metric-drop`.
- On a pull request, post or update a single comment (marker `<!-- litmiq-ci-comment -->`) with the results table and missed thresholds when `GITHUB_TOKEN` is present. The workflow needs `permissions: pull-requests: write`. `--no-pr-comment` or an empty `github_token` input skips this. A missed threshold still exits 1 so a required check can block the merge.
- Baseline and results JSON now store per-metric averages. Existing overall average and pass-rate gates are unchanged.

## 1.0.0 — 20 November 2026


- CLI `litmiq-ci.mjs`: run a Litmiq suite, compare a baseline, write results, optional Slack-compatible regression webhook. `--validate` and `--help` added.
- GitHub Action `litmiq/litmiq-ci@v1` wraps the same CLI.
- MCP stdio server (`mcp/server.mjs`) with `validate_suite`, `run_suite`, and `read_results`.
- Offline tests only; no provider calls in CI for this repository.
