# omp-grok-build

Use a **Grok Build CLI subscription** from [Oh My Pi](https://omp.sh) via the Grok CLI entitlement proxy.

This extension registers OMP provider `grok-build`, reuses the official Grok CLI login when available, supports native device-code OAuth, discovers the live Grok CLI model catalog, and adds `/grok-build-usage` for subscription billing.

It does **not** use the public xAI inference API.

```text
Inference/model/billing: https://cli-chat-proxy.grok.com/v1
OAuth only:              https://auth.x.ai
```

This package lives under the multi-plugin marketplace repo. Catalog entry:

```text
omp-grok-build@omp-ext
source: ./plugins/omp-grok-build
```

## Install

```bash
omp plugin marketplace add notquite28/omp-ext
omp install omp-grok-build@omp-ext

# local link while developing
omp install ./plugins/omp-grok-build --force
```

With profile alias `grk` (`omp --profile grok-build --alias grk`):

```bash
grk install omp-grok-build@omp-ext
grk plugin marketplace update
grk plugin upgrade omp-grok-build@omp-ext
```

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

## Models

```text
grok-build/grok-4.5
grok-build/grok-composer-2.5-fast
```

See the repository root README for marketplace layout and dual-plugin install.
