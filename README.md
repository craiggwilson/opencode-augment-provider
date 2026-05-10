# opencode-augment-provider

An [OpenCode](https://opencode.ai) plugin and provider that routes AI requests through your [Augment Code](https://www.augmentcode.com) subscription. If you already have Augment Code, this lets you use that same subscription inside OpenCode without paying for a separate API key.

## Why this exists

OpenCode ships with providers for Anthropic, OpenAI, and others, but it has no built-in support for Augment Code. This package fills that gap. It speaks OpenCode's provider protocol and translates requests into the Augment `/chat-stream` API, so you get the full OpenCode experience — tool use, streaming, the sidebar — powered by your existing Augment account.

## Prerequisites

- [OpenCode](https://opencode.ai) installed and working
- An active [Augment Code](https://www.augmentcode.com) account
- One of the following for authentication (see [Authentication](#authentication))

## Authentication

Credentials are resolved in this order:

1. **Session file** — `~/.augment/session.json` written by `auggie login`. This is the recommended approach if you use the Augment CLI.
2. **Environment variable** — set `AUGMENT_API_KEY` (and optionally `AUGMENT_API_URL`) in your shell.
3. **Explicit options** — pass `apiKey` / `apiUrl` directly in the provider options block of your OpenCode config.

If none of these resolve, OpenCode will fail to start the provider with an error pointing you to the missing credentials.

## Usage

There are two ways to use this package with OpenCode: as a **plugin** or as a **provider**. The plugin method is recommended because it handles all wiring automatically.

### Method 1: Plugin (recommended)

The plugin method lets OpenCode load and configure the provider for you. You only need to tell OpenCode where the package lives — the plugin injects the `npm` path, wires up logging, and registers the models returned by Augment's `/get-models` registry automatically.

**Step 1 — Install the package**

```bash
npm install -g opencode-augment-provider
# or with bun
bun add -g opencode-augment-provider
```

Note the installation path (e.g. `/usr/local/lib/node_modules/opencode-augment-provider`).

**Step 2 — Edit your OpenCode config**

Add a `plugin` entry pointing to the package directory. No `provider` block is required:

```json
{
  "plugin": [
    "file:///usr/local/lib/node_modules/opencode-augment-provider"
  ]
}
```

That's it. The plugin will register all available Augment models in the model picker on startup.

If you want to customise the model list — for example to add a newly released model or change token limits — add an explicit `provider.augment.models` block. Any models you declare there will be used as-is; the defaults are only applied when no models are configured:

```json
{
  "plugin": [
    "file:///usr/local/lib/node_modules/opencode-augment-provider"
  ],
  "provider": {
    "augment": {
      "models": {
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6",
          "limit": { "context": 200000, "output": 16000 }
        }
      }
    }
  }
}
```

**Step 3 — Start OpenCode**

OpenCode will load the plugin on startup and the Augment models will appear in the model picker.

---

### Method 2: Provider (manual)

Use this method if you prefer explicit configuration or are not using the plugin loader.

> **Note:** When using the provider directly, no default models are injected. You must declare every model you want to use in your config.

**Step 1 — Install and build the package**

```bash
npm install opencode-augment-provider
# or with bun
bun add opencode-augment-provider
```

**Step 2 — Edit your OpenCode config**

Point the `npm` field at the package root and declare all the models you want:

```json
{
  "provider": {
    "augment": {
      "name": "Augment Code",
      "npm": "file:///path/to/node_modules/opencode-augment-provider",
      "models": {
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6",
          "limit": { "context": 200000, "output": 16000 }
        },
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5",
          "limit": { "context": 200000, "output": 8000 }
        }
      }
    }
  }
}
```

Replace `/path/to/node_modules/opencode-augment-provider` with the actual path on your system.

---

## Available models

When loaded as a plugin, the provider discovers models from Augment's `/get-models` registry and registers exactly the returned model IDs. There is no hardcoded default list, no CLI fallback, and no local filtering. If discovery fails, no models are injected; configure `provider.augment.models` manually if you need an explicit fallback.

When using the provider directly instead of the plugin, you must list every model explicitly in your OpenCode config.

Token limits are inferred from the returned registry entry and model ID because OpenCode requires them for display and budgeting. See [docs.augmentcode.com/models](https://docs.augmentcode.com/models) for Augment's product-level model list.

---

## Nix / Home Manager

A Home Manager module is included under `integrations/nix/home-manager.nix`. It wraps everything into a single `programs.opencode-augment-provider` option set:

```nix
programs.opencode-augment-provider = {
  enable = true;
  # leave models empty to let the plugin discover them at runtime
};
```

Enabling the module writes the plugin block into `programs.opencode.settings` automatically. It only writes `provider.augment` when you explicitly set `programs.opencode-augment-provider.models`. Remove any existing `programs.opencode.settings.provider.augment` definitions from your config before setting explicit models to avoid conflicts.

---

## License

MIT — see [LICENSE](./LICENSE).
