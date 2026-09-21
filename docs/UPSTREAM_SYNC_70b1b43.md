# Upstream 3.14.1-27 sync status

This merge incorporates kingsword09/zcode-cli main at `70b1b43` into fork main
at `46b7240`. It is a draft integration and must not be released yet.

## Resolved integration

- Adopt the upstream shared native provider registry and settings migration.
- Replace legacy Desktop token copying with native shared credential detection.
- Preserve portable OAuth callbacks and first-run Skip/Esc/login outcome handling.
- Preserve Factory patch requirements and three-day CI artifact retention.

## Validation

- `bun install --frozen-lockfile`: passed (local Bun 1.3.14; CI pins 1.4.1).
- `bun run typecheck`: passed.
- Focused native auth, first-run setup, login flow/setup, and workflow tests: 27 passed.
- `git diff --check`: passed.
- Initial unit run before runtime extraction: 673 passed, 17 failed, 1 error.
  Most failures lacked the extracted runtime; one artifact retention failure was
  subsequently fixed and its focused test passed. This is not a green full suite.
- `bun run sync:locked`: failed on the required usage-footer patch against the
  SHA-512-verified locked 3.14.1 runtime. No working release was produced.

## Required runtime ports

A diagnostic pass continued after each failed patch solely to inventory failures.
It did not relax requirements, install a partially patched runtime, or qualify a release.

| Patch | Missing anchor |
| --- | --- |
| usage-footer | runPrompt non-JSON exit |
| route-selection | legacy model config keys |
| runtime-attestation | tool executor route config input |
| strict-advisor-hooks | foreground empty output |

The optional context-cache-from-parts patch also lacks its old aggregator anchor.
All other patch applications and their configured verifiers passed in this diagnostic.

The new provider registry replaces legacy main/lite model configuration. Porting
Advisor requires preserving frozen parent/child route policy, persistence,
unsupported-effort rejection, and native runtime evidence through the new model
selection APIs. The launcher model/reasoning override writer also still targets
legacy `config.model` fields and needs the same migration. Do not mark these
patches optional or remove their checks to make the release pass.

Before merge: complete the runtime ports and override migration, run the full
release build and pack/install validation, and obtain passing CI.
