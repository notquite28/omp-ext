# omp-grok-build marketplace

Oh My Pi marketplace containing **two separate plugins**:

| Plugin | What it does |
| --- | --- |
| [`omp-grok-build`](./plugins/omp-grok-build) | Grok Build CLI subscription provider (`grok-build/*` models, OAuth, `/grok-build-usage`) |
| [`omp-rewind`](./plugins/omp-rewind) | Git worktree checkpoints — `/rewind`, Esc+Esc, safe restore, redo stack |

Repo layout:

```text
.
├── .claude-plugin/marketplace.json   # catalog (multi-plugin)
├── plugins/
│   ├── omp-grok-build/               # provider extension
│   └── omp-rewind/                   # checkpoint/rewind extension
└── package.json                      # marketplace workspace scripts only
```

## Install (marketplace)

```bash
# once per profile
omp plugin marketplace add notquite28/omp-grok-build
# or with the grk profile alias:
grk plugin marketplace add notquite28/omp-grok-build

# install plugins independently
omp install omp-grok-build@omp-grok-build-marketplace
omp install omp-rewind@omp-grok-build-marketplace
```

With the isolated Grok profile alias (`omp --profile grok-build --alias grk`):

```bash
grk install omp-grok-build@omp-grok-build-marketplace
grk install omp-rewind@omp-grok-build-marketplace
```

### Update

```bash
grk plugin marketplace update
grk plugin upgrade
# or one plugin:
grk plugin upgrade omp-rewind@omp-grok-build-marketplace
grk plugin upgrade omp-grok-build@omp-grok-build-marketplace
```

`marketplace update` refreshes the catalog from GitHub; `plugin upgrade` applies newer catalog versions to installed marketplace plugins.

## Local development

```bash
# link a single plugin from a checkout
omp install ./plugins/omp-grok-build --force
omp install ./plugins/omp-rewind --force

# or for the grk profile
grk install ./plugins/omp-grok-build --force
grk install ./plugins/omp-rewind --force
```

Tests:

```bash
# Grok plugin (needs deps)
cd plugins/omp-grok-build && bun install --frozen-lockfile
bun run typecheck
bun test

# Rewind plugin (no deps)
cd plugins/omp-rewind && bun tests/core.test.ts
```

From repo root (after `bun install` in the Grok plugin dir):

```bash
bun run test:grok
bun run test:rewind
```

## Plugin docs

- **Grok Build provider** — [plugins/omp-grok-build](./plugins/omp-grok-build) (see root history / AGENTS for architecture; install section above)
- **Rewind** — [plugins/omp-rewind/README.md](./plugins/omp-rewind/README.md)

### Note on extension loading

Both plugins are TypeScript **extension factories** (`package.json` → `omp.extensions`). Prefer marketplace install for update tracking. If a host build does not load factories from the marketplace cache, fall back to:

```bash
omp install ./plugins/omp-rewind --force
# or
omp install github:notquite28/omp-grok-build
```

and open an issue — marketplace install is the intended path for this catalog.

## Releases

Marketplace catalog metadata version lives in:

- root `package.json` `version`
- `.claude-plugin/marketplace.json` → `metadata.version`

Each plugin has its **own** version in `plugins/<name>/package.json` and a matching entry in the catalog `plugins[].version`.

Tag releases as `vX.Y.Z` matching the **marketplace** metadata version (not necessarily a plugin version). CI validates catalog entries match each plugin package version, then publishes a source archive.

```bash
# example: bump rewind only
# 1. plugins/omp-rewind/package.json version
# 2. catalog plugins[name=omp-rewind].version
# 3. optionally bump marketplace metadata.version + root package.json
# 4. commit, tag vX.Y.Z, push
```

## License

Plugin licenses live with each package (`plugins/omp-rewind` is MIT). Grok plugin remains as previously published.
