# litmiq-ci

[![test](https://github.com/litmiq/litmiq-ci/actions/workflows/test.yml/badge.svg)](https://github.com/litmiq/litmiq-ci/actions/workflows/test.yml)

Open-source **CLI**, **GitHub Action**, and **MCP connector** for [Litmiq](https://litmiq.com) regression suites. No dependencies. Node 18+.

You export a suite from [the Litmiq app](https://litmiq.com/app) (or write a `litmiq-suite/1` JSON file), then run the same scoring the app uses: one LLM judge call per output, metrics 0–10, pass = overall ≥ 7. Missing scores are never invented. Provider calls use **your** OpenAI and/or Anthropic keys; this project does not keep them and does not bill you.

The tool is free. OpenAI or Anthropic bill API usage to your key.

## CLI

```bash
# from a clone
node litmiq-ci.mjs path/to/suite.json --out litmiq-results.json --baseline litmiq-baseline.json

# check the file only (no keys, no provider calls)
node litmiq-ci.mjs path/to/suite.json --validate

# after install
npx github:litmiq/litmiq-ci -- path/to/suite.json --validate
```

Flags: `--validate`, `--out file`, `--baseline file`, `--update-baseline`, `--max-avg-drop`, `--max-pass-rate-drop`, `--min-avg`, `--min-pass-rate`, `--max-metric-drop`, `--no-pr-comment`, `--help`.

Exit codes: `0` pass, `1` regression or threshold miss, `2` usage or config error, `3` provider errors on every call.

Environment:

- `OPENAI_API_KEY` — required when the suite or judge uses an OpenAI model
- `ANTHROPIC_API_KEY` — required when the suite or judge uses a Claude model
- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — optional, for proxies or tests
- `LITMIQ_ALERT_WEBHOOK` — optional Slack-compatible incoming webhook, posted to only when a regression is found
- `GITHUB_STEP_SUMMARY` — when set (GitHub Actions), the markdown table is appended there
- `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH` — when set on a pull request, the CLI posts or updates one comment with the table and any missed thresholds. A comment failure is logged and does not change the exit code. `LITMIQ_NO_PR_COMMENT=1` skips this.

This CLI currently calls the official OpenAI and Anthropic APIs (or a base URL you set). Browser-only providers in the Litmiq app are not run here.

## GitHub Action

```yaml
# .github/workflows/litmiq-evals.yml
name: Litmiq evals
on:
  pull_request:
  push:
    paths: ['litmiq/**']
  schedule:
    - cron: '17 6 * * 1'
permissions:
  contents: read
  pull-requests: write
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: litmiq/litmiq-ci@v1
        with:
          suite: litmiq/litmiq-suite.json
          baseline: litmiq/litmiq-baseline.json
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

A missed threshold or provider error exits non-zero and fails the job. If this workflow is a required status check, GitHub will block the merge. On a pull request the Action posts or updates a single comment with the score table and any missed thresholds, using `GITHUB_TOKEN`. That needs `permissions: pull-requests: write`. Review the workflow and the suite before you rely on them. You can also download this same CLI from the Litmiq app workspace (Pro can export a scheduled workflow).

## MCP connector

A stdio MCP server, no dependencies, exposes three tools: `validate_suite`, `run_suite`, and `read_results`. `run_suite` uses the same CLI and the keys already in the server environment.

```json
{
  "mcpServers": {
    "litmiq-ci": {
      "command": "node",
      "args": ["/path/to/litmiq-ci/mcp/server.mjs"],
      "env": {
        "OPENAI_API_KEY": "your-key",
        "ANTHROPIC_API_KEY": "your-key"
      }
    }
  }
}
```

## Suite format

`schema` is `litmiq-suite/1`. `litmiq_fields.system_prompt` and `cases[].user_input` are required. Optional: `expected_behavior`, `models`, `judge_model`, and `ci` (`pass_score`, `max_avg_drop`, `max_pass_rate_drop`, `min_avg`, `min_pass_rate`, `max_metric_drop`, `max_metric_drops`, `min_metrics`). Per-metric gates compare averages of scores the judge actually returned (for example `accuracy`); missing scores are not invented. An example is in [`examples/refund-verification.suite.json`](examples/refund-verification.suite.json). Export one from https://litmiq.com/app.

## What this is not

It is not a hosted eval service, not a replacement for the Litmiq app, and not a way to share your keys or suites with Litmiq. Team-wide shared workspaces still need a backend; this repo is the local and CI path.

## License

MIT. Copyright (c) 2026 Devansh Kaushik.

Contact: hello@litmiq.com
