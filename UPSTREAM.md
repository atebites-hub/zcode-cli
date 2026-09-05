# Upstream fork maintenance

This repository is a **true GitHub fork** of [kingsword09/zcode-cli](https://github.com/kingsword09/zcode-cli). Keep `fork: true` and that parent. Do not convert it to a standalone repo, and do not delete [atebites-hub/zcode-cli-legacy](https://github.com/atebites-hub/zcode-cli-legacy) (historical factory source).

Factory-owned behavior lives on `main` as first-class commits. Upstream moves in through `chore: sync upstream` pull requests. Never force-push `main` unless it is still identical to upstream and the only path is a reviewable PR.

## Remotes

| Remote | URL | Role |
| --- | --- | --- |
| `origin` | https://github.com/atebites-hub/zcode-cli.git | This fork (push / PRs) |
| `upstream` | https://github.com/kingsword09/zcode-cli.git | Parent (fetch only) |

```bash
git remote add origin https://github.com/atebites-hub/zcode-cli.git   # if missing
git remote add upstream https://github.com/kingsword09/zcode-cli.git  # if missing
git remote -v
# origin    https://github.com/atebites-hub/zcode-cli.git (fetch/push)
# upstream  https://github.com/kingsword09/zcode-cli.git (fetch)
```

Optional historical remote (read-only; not required for sync):

```bash
git remote add legacy https://github.com/atebites-hub/zcode-cli-legacy.git
```

Do not `git push` to `upstream`.

## Last synced upstream tip

- **Upstream:** https://github.com/kingsword09/zcode-cli
- **Parent:** [kingsword09/zcode-cli](https://github.com/kingsword09/zcode-cli)
- **Last synced upstream tip:** <!-- upstream-tip-begin -->`83c924d25e0d450d1ad49d2a8cfc594c65f7dc4b` (`3.11.2-20`, `docs(config): drop redundant capability fields from multimodal guide (#128)`)<!-- upstream-tip-end -->
- **Legacy last shared ancestor:** `7f3d73b5c3daa1b5c2b8585e4a6b5899014ac6d7` (`3.10.2-18`). Factory patches were retargeted on that tree, then replayed onto `2c9f458` and merged forward through this tip (upstream `5b6a6fd`–`83c924d`).

The weekday sync workflow rewrites only the `upstream-tip-begin/end` span when it opens a clean sync PR.

## Owners

- **Jaskarn** (atebites-hub)
- **Factory Plugins bot**

## Divergence (patches we own)

These are atebites-only. Do not drop them in an upstream merge without recording the deferral here.

| Patch / behavior | Why we keep it | Conflict risk | Legacy source |
| --- | --- | --- | --- |
| `ZCODE_ODW_PROTOCOL=1` machine-readable result envelope (`src/launcher.ts`) | ODW needs a single JSON `zcode_result` on stdout instead of TUI/text | Medium — launcher argv/env routing changes upstream | `3b6be05`, `3dc8766` |
| Isolate unsupported `--model` / `--reasoning-effort` from the runtime CLI | Official parser rejects those flags; launcher maps them onto temp settings + `ZCODE_RUNTIME_ROUTE_OVERRIDE` | Medium — option parsing in `launcher.ts` | `da56ef9`, `55c21d6` |
| Protocol-path hardening | `prepared.cleanup()` in `finally`; forward SIGINT/SIGTERM/SIGHUP to the runtime child | Low | `3dc8766` |
| `usage-footer` runtime patch | Stderr `{"type":"zcode_usage",...}` so ODW envelopes get token totals | **High** — anchored on minified `runPrompt` exits | `3dc8766`, `cbd3e6b` |
| `route-selection` runtime patch | Exact Advisor main/lite model + thought-level overrides; persist immutable role policy | **High** — minified session/persist symbols | `55c21d6`, `afdafbc`, `cbd3e6b`, `8a4187c` |
| `runtime-attestation` runtime patch | Native Agent + Advisor result attestation (`zcode_runtime_attestation`) | **High** — minified hook/session symbols | `afdafbc`, `6093efa`, `cbd3e6b` |
| `strict-advisor-hooks` runtime patch | Fail-closed exact Advisor plugin hooks; record `ZCODE_STRICT_ADVISOR_HOOK_FAILURE` on protocol retries | **High** — `sendInput` / protocol completion shape | `afdafbc`, `b409cdb`, `80a0b60` |
| Config + docs for `mainThoughtLevel` / `liteThoughtLevel` and strict consumers | Documents Advisor role pairs; does not silently enable user hooks | Low (docs) / Medium (`config.example.json` catalog edits) | `afdafbc` |
| Advisor runtime integration tests | Split hook modes; poll attestation/session idle instead of fixed sleeps | Medium — tests track runtime/protocol timing | `2395c0b` |
| `context-cache-from-parts` | Optional 3.8.1 read-path fallback; **skip on 3.10.2** (bug fixed upstream; minified names moved) | Low — optional, expected to skip | `cbd3e6b` |

Required factory patch ids in `runtimePatchPlan`: `usage-footer`, `route-selection`, `runtime-attestation`, `strict-advisor-hooks`. Optional: `context-cache-from-parts`.

On the 3.11.2 tip, `route-selection` restore-policy input and `strict-advisor-hooks` foreground empty-output anchors were retargeted (minified locals + extra restore-call args + hook `{output,diagnostics}` unwrap). `context-cache-from-parts` still skips as expected.

## Deferred (intentionally not in this fork yet)

| Item | Reason |
| --- | --- |
| `45bd0e7` `chore(release): prepare zcode-app-cli 3.8.1-16` | Version bump would regress `3.10.2-19` |
| atebites-plugins pin bumps | Separate PR after this port is green |
| ODW submodule | Separate PR after this port is green |
| Merge commits from legacy (`875b6ad`, `4a392a7`, `bec2f2a`, `e5abcf9`, `b2be1e6`, `29ec3d0`, `a97033f`, `1ccf501`, `f5c6eef`, `6b7e8b4`, `227b592`) | Content recovered via the feature commits above |

## Sync policy (Project Factory FORK-MAINTENANCE)

1. **Keep the GitHub fork relationship.** Parent must stay `kingsword09/zcode-cli`.
2. **Never rewrite published `main`.** No force-push to `main`. Exception only if `main` is still byte-identical to `upstream/main` and the change still goes through a PR.
3. **Do not rebase factory commits off `main`.** Replay happens by *merging* `upstream/main` into a branch that already has factory commits.
4. **Sync through a PR titled exactly `chore: sync upstream`** into `main`. Prefer GitHub **Create a merge commit** (not squash, not rebase) so factory SHAs stay reachable and the next merge has a sane merge-base.
5. **Preserve factory patch ids.** When `scripts/sync-runtime.ts` conflicts, keep `usage-footer`, `route-selection`, `runtime-attestation`, and `strict-advisor-hooks` in `runtimePatchPlan`. Retarget minified anchors; do not delete the patches.
6. **Update this file** after each successful sync: last synced tip (the `upstream-tip` markers) and any new divergence or deferral.
7. **Leave `zcode-cli-legacy` alone.** It is provenance, not a second live fork.

### Manual sync

```bash
git fetch origin
git fetch upstream
git checkout -b chore/sync-upstream-$(git rev-parse --short upstream/main) origin/main

# Skip if we already contain upstream/main:
#   git merge-base --is-ancestor upstream/main HEAD && echo already synced

git merge --no-ff upstream/main -m "chore: merge upstream $(git rev-parse --short upstream/main)"
# Resolve conflicts using the divergence table. Keep factory patches.
# Update the Last synced upstream tip markers in this file.

git push -u origin HEAD
# Open PR title: chore: sync upstream
# Merge with a merge commit.
```

Weekday automation: `.github/workflows/sync-upstream.yml` (UTC cron, plus `workflow_dispatch`). If an open PR already has that exact title, the workflow leaves it alone.

`GITHUB_TOKEN` pull requests do not start other workflows. Set repository secret `UPSTREAM_SYNC_TOKEN` (Factory Plugins bot PAT with `contents` + `pull-requests`) so sync PRs still run CI.

### After every sync

- [ ] Factory patch ids still present and required ones applied (or documented skipped)
- [ ] `bun test` / `bun run check` as far as the harness allows
- [ ] This file’s last-synced SHA matches `upstream/main`
- [ ] Fork still `fork: true` with parent `kingsword09/zcode-cli`
