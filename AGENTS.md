# Repository Guidelines

## Project Overview

This repository is an **Oh My Pi marketplace** (`omp-ext`) that ships **two independent plugins**:

| Path | Package | Role |
| --- | --- | --- |
| `plugins/omp-grok-build/` | `omp-grok-build` | Grok Build CLI provider (`grok-build/*`, usage, Imagine) |
| `plugins/omp-rewind/` | `omp-rewind` | Git checkpoint/rewind (`/rewind`, Esc+Esc) |

Do **not** merge the two into one `package.json` / one `omp.extensions` entry. Users install them separately:

```text
omp-grok-build@omp-ext
omp-rewind@omp-ext
```

### Grok plugin (`plugins/omp-grok-build`)

Lets OMP use a **Grok Build CLI subscription** through the CLI entitlement proxy for chat/models/billing. Image generation intentionally calls the public xAI images API with the same OAuth token (same split as upstream `pi-grok-cli`).

Do **not** route chat inference or billing to `https://api.x.ai`; target:

```text
https://cli-chat-proxy.grok.com/v1
```

```text
OMP host
  └─ plugins/omp-grok-build/package.json → omp.extensions → src/main.ts
       ├─ registerProvider("grok-build")
       ├─ on("before_provider_request") → sanitizeProxyPayload
       ├─ registerCommand("grok-build-usage") → GET /v1/billing
       └─ registerImagineCommand → /grok-build-imagine + image_gen tool
```

### Rewind plugin (`plugins/omp-rewind`)

Git-based working-tree checkpoints. Core is pure git (`core.ts`); host wiring in `index.ts` / `commands.ts`. Checkpoint refs stay under `refs/pi-checkpoints/` (shared with upstream pi-rewind).

```text
OMP host
  └─ plugins/omp-rewind/package.json → omp.extensions → src/index.ts
       ├─ turn/tool hooks → createCheckpoint
       ├─ /rewind + Esc+Esc → restore
       └─ footer ◆ N checkpoints
```

## Key Directories

| Path | Purpose |
| --- | --- |
| `.claude-plugin/marketplace.json` | Multi-plugin catalog (`source`: `./plugins/...`) |
| `plugins/omp-grok-build/` | Grok provider package (own `package.json`, `src/`, `test/`, lockfile) |
| `plugins/omp-rewind/` | Rewind package (own `package.json`, `src/`, `tests/`) |
| `.github/workflows/` | CI for both plugins; release validates catalog vs package versions |
| Root `package.json` | Workspace scripts only — **not** an installable extension |

## Development Commands

```bash
# Grok
cd plugins/omp-grok-build
bun install --frozen-lockfile
bun run typecheck
bun test

# Rewind
cd plugins/omp-rewind
bun tests/core.test.ts

# Link into current profile
omp install ./plugins/omp-grok-build --force
omp install ./plugins/omp-rewind --force

# Marketplace flow (after push / local marketplace add)
omp plugin marketplace update
omp install omp-rewind@omp-ext
omp plugin upgrade
```

## Versioning & Releases

- **Plugin versions** are independent (`omp-grok-build` 0.1.x vs `omp-rewind` 0.5.x).
- Catalog entry `plugins[].version` **must** match that plugin’s `package.json` version.
- **Marketplace metadata version** (`metadata.version` + root `package.json`) is the tag target for GitHub releases (`vX.Y.Z`).
- Bumping only rewind: change rewind package + catalog entry; bump marketplace metadata when cutting a catalog release tag.

## Code Conventions

### Grok (`plugins/omp-grok-build`)

- One concern per file: `main.ts`, `auth.ts`, `models.ts`, `payload.ts`, `usage.ts`, `imagine/*`.
- Provider id: `grok-build`. Commands: `grok-build-usage`, `grok-build-imagine`. Tool: `image_gen`.
- Never switch chat/billing base URL to public `api.x.ai`. Imagine may call `api.x.ai/v1/images/generations` only.

### Rewind (`plugins/omp-rewind`)

- `core.ts` must stay free of `@oh-my-pi/*` imports.
- Host types from `@oh-my-pi/pi-coding-agent` only.
- `MUTATING_TOOLS` includes OMP builtins: write, edit, bash, ast_edit, eval.
- Keep `refs/pi-checkpoints/` namespace.

## Testing

- Grok: `bun test` under `plugins/omp-grok-build` before behavior changes to auth/provider/models/payload/usage/imagine.
- Rewind: `bun tests/core.test.ts` for git ops + mutating-tool set.
- CI runs both plus catalog/package version alignment.

## Non-goals

- Do not reintroduce root-level `omp.extensions` for the marketplace package.
- Do not set catalog `source` back to `"./"` (single-plugin root layout).
- Do not vendor either plugin into `oh-my-pi` itself.
