# AGENTS.md

Instructions for AI agents working on this repository.

## Project overview

`opencode-augment-provider` is a TypeScript library that implements the [Vercel AI SDK](https://sdk.vercel.ai) `ProviderV2` interface, routing language model requests through the Augment AI SDK (`@augmentcode/auggie-sdk`). It is designed to be used as a provider plugin for [OpenCode](https://opencode.ai).

## Key files

| File | Purpose |
|:-----|:--------|
| `src/index.ts` | Barrel export — public API surface |
| `src/augment-model.ts` | Provider implementation and credential resolution |
| `biome.json` | Linter and formatter configuration |
| `tsconfig.json` | TypeScript compiler configuration |
| `package.json` | Package metadata, scripts, and dependencies |

## Build

```bash
bun run build   # compiles src/ → dist/ via tsc
bun run dev     # watch mode
bun run clean   # removes dist/
```

Output goes to `dist/`. The build must succeed before any changes are merged.

## Lint and format

```bash
bun run lint    # biome lint — no writes
bun run format  # biome format --write — applies formatting
bun run check   # biome check — lint + format, no writes
```

Run `bun run check` before finishing any task to ensure the code is clean.

## Testing

There is no automated test suite yet. Verify changes by building successfully and manually confirming credential resolution behavior if relevant.

## Coding conventions

- Follow the ordering within files: imports → constants → types → exported items → private items. All groups alphabetized.
- Alphabetize fields within types and objects.
- All exported types and functions must have JSDoc documentation explaining purpose and usage (not implementation).
- Prefer explicit error handling; add context to errors at the point of failure.
- No abbreviations unless commonly understood (`cfg`, `ctx`, `id`).
- Immutability over shared state; avoid global mutable state (the `cachedConfig` in `augment-model.ts` is a deliberate exception for performance).
- Log only at system boundaries and only when `OPENCODE_AUGMENT_PROVIDER_DEBUG` is set — never in hot paths.

## Dependencies

- Runtime: `@ai-sdk/provider`, `@augmentcode/auggie-sdk`
- Dev: `typescript`, `@biomejs/biome`, `@types/node`

Use `bun add` / `bun remove` to manage dependencies. Do not edit `package.json` dependency versions by hand.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>
```

Common types:

| Type | When to use |
|:-----|:------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `chore` | Maintenance, dependency updates, tooling |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `build` | Changes to build system or scripts |

Examples:

```
feat: add support for streaming responses
fix: handle missing tenantURL in session file
chore: update @augmentcode/auggie-sdk to 0.1.16
docs: document AUGMENT_API_URL environment variable
```

## Publishing

Publishing is manual. The `publishConfig` in `package.json` targets the public npm registry. Do not add automated publish steps without explicit instruction.
