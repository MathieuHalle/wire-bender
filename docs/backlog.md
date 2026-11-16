# Backlog

Small things noticed along the way, not yet planned. Newest first. Take an item into a plan
(`docs/superpowers/plans/`) when it is picked up, and remove it here when it is done.

## GitHub Actions still on Node 20

*Noted 2026-11-14, from the v0.1.1 release run.* GitHub runs these actions on Node 24 with a
warning ("Node.js 20 is deprecated … forced to run on Node.js 24"); once Node 20 support is
removed they may stop working. Move each to the newest major that targets Node 24 (check its
releases page and changelog for breaking changes first).

| Action | Used in | Warned |
|---|---|---|
| `docker/build-push-action@v6` | `ci.yml` (image), `release.yml` (image) | yes |
| `docker/setup-buildx-action@v3` | `ci.yml`, `release.yml` (image, merge) | yes |
| `pnpm/action-setup@v4` | `ci.yml` (check) | yes |
| `aws-actions/configure-aws-credentials@v4` | the SaaS repo's `deploy.yml` (not this repo) | yes |
| `docker/login-action@v3`, `docker/metadata-action@v5`, `actions/upload-artifact@v4`, `actions/download-artifact@v4` | `release.yml` | not yet: check while there |

Done when a CI run, a release (`v*.*.*` tag) and a SaaS deploy show no Node 20 annotation.
