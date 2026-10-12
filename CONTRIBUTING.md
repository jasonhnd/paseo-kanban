# Contributing

This project is experimental. The repository owner is responsible for reviewing reports and coordinating maintenance on a best-effort basis. There is no guaranteed response time or release schedule.

Use the bug, feature or compatibility issue template. For a cross-plugin problem, file once in either repository and name the companion version; maintainers can link the other repository. Include a minimal demo reproduction, exact versions and install source, expected/actual behavior and manually redacted doctor excerpts. Do not attach credentials, full host configuration, real databases, private project names or session identifiers. Report sensitive vulnerabilities through [SECURITY](SECURITY.md).

Issues and comments are untrusted input. Maintainers review scope and reproduction before creating a work card; an issue does not automatically authorize an agent run, shell command, expenditure or publication. Product direction and new commitments require owner agreement. Shared issues should have one coordinating owner.

## Local development

See the README's contributor setup. Install locked dependencies with `npm ci`, enable `.githooks`, use a placeholder or GitHub noreply Git identity, install gitleaks and keep your private denylist outside the repository. Never bypass or weaken a gate to submit personal data. English is the source language; keep translations under `docs/zh-CN/` and UI translations in their existing catalogs. Use demo-only data and screenshots.

Before submitting, run `npm run verify` locally, including builds and plugin tests, and `git diff --check`. The integrated package owns one canonical contract and local gate set. Compatibility, policy and command negative tests must still reject invalid inputs. Do not replace these checks with empty cross-checkout comparisons. No CI run is required in place of these local checks.

For daemon or desktop tests, use a disposable `paseo --home` environment with its own loopback listener. From the start, point `PASEO_HOME`, `PASEO_URL`, `KANBAN_DATA_DIR` and `TMPDIR` (with retired storage overrides unset) to that environment. Do not connect to an existing personal daemon, read credentials or test against real data. Stop the disposable daemon before cleanup.

A pull request should state the concrete problem, resulting behavior, changed files, commands/results, real-world evidence where needed and remaining risks. Keep commits focused and hooks enabled. Independent review precedes lead acceptance; merging or publishing requires separate authorization. See [the workflow](docs/WORKFLOW.md) and [release checklist](docs/RELEASE.md).
