# opencode-augment-provider

An [OpenCode](https://opencode.ai) provider that routes language model requests through the [Augment](https://augmentcode.com) AI SDK.

## Installation

```bash
npm install opencode-augment-provider
```

## Usage

```typescript
import { createAugment } from "opencode-augment-provider";

const provider = createAugment();
const model = provider.languageModel("claude-sonnet-4-6");
```

Pass explicit credentials if needed:

```typescript
const provider = createAugment({
  apiKey: "your-api-key",
  apiUrl: "https://api.augmentcode.com",
});
```

## Credential resolution

Credentials are resolved in the following order:

1. **Explicit options** — `apiKey` and `apiUrl` passed to `createAugment()`
2. **Environment variables** — `AUGMENT_API_KEY` and `AUGMENT_API_URL`
3. **Session file** — `~/.augment/session.json` written by the Augment CLI after `auggie login`

An error is thrown at model creation time if no credentials can be resolved.

## Environment variables

| Variable | Description |
|:---------|:------------|
| `AUGMENT_API_KEY` | Augment API key |
| `AUGMENT_API_URL` | Augment API base URL (defaults to `https://api.augmentcode.com`) |
| `OPENCODE_AUGMENT_PROVIDER_DEBUG` | Set to any value to enable debug logging to stderr |

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Watch mode
bun run dev

# Lint
bun run lint

# Format
bun run format

# Lint + format check (no writes)
bun run check

# Clean build output
bun run clean
```

## Contributing

Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages:

```
<type>(<scope>): <short summary>
```

| Type | When to use |
|:-----|:------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `chore` | Maintenance, dependency updates, tooling |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `build` | Changes to build system or scripts |

## License

MIT
