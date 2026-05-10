import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { AugmentLanguageModel, type AugmentLanguageModelConfig } from "./language-model.js";

/** Default Augment API URL used when no other URL is configured. */
const DEFAULT_API_URL = "https://api.augmentcode.com";

/** Absolute `file://` URL of the package root, derived from this module's location. */
const PACKAGE_ROOT = url.pathToFileURL(
  path.resolve(url.fileURLToPath(import.meta.url), "..", "..")
).href;

/**
 * Minimal logger interface used by the Augment provider for debug output.
 *
 * The default implementation writes to stderr (safe for TUI environments).
 * When used as an OpenCode plugin, the plugin entry point passes an
 * implementation backed by `client.app.log` via `AugmentProviderOptions.logger`.
 */
export interface Logger {
  /** Emit a debug-level message, optionally with structured extra fields. */
  debug(message: string, extra?: Record<string, unknown>): void;
}

/**
 * Configuration options for the Augment provider.
 *
 * Credentials are resolved in the following order:
 * 1. Explicit `apiKey` option
 * 2. `AUGMENT_API_KEY` environment variable
 * 3. `~/.augment/session.json` file (created by Augment CLI login)
 */
export interface AugmentProviderOptions {
  /** Augment API key. If not provided, falls back to environment or session file. */
  apiKey?: string;
  /** Augment API URL. Defaults to the URL from session file or standard Augment API. */
  apiUrl?: string;
  /**
   * Logger for debug output. Defaults to a stderr-based logger.
   *
   * When used as an OpenCode plugin, the plugin entry point injects an
   * implementation backed by `client.app.log` so output goes through
   * OpenCode's logging infrastructure rather than directly to stderr.
   */
  logger?: Logger;
}

/** Cached config to avoid re-reading session file on every model creation. */
let cachedConfig: AugmentLanguageModelConfig | null = null;

/** Structure of ~/.augment/session.json created by Augment CLI. */
interface AugmentSession {
  accessToken: string;
  tenantURL: string;
}

type ModelDefinition = { name: string; limit: { context: number; output: number } };

/** A single model entry from Augment's model info registry feature flag. */
interface AugmentModelInfo {
  displayName: string;
  shortName: string;
  costTier?: number;
  disabled?: boolean;
}

/** The subset of the `/get-models` response used for dynamic model discovery. */
interface GetModelsResponse {
  feature_flags?: {
    model_info_registry?: string;
  };
}

/**
 * Derives context window and output token limits from an Augment registry entry.
 *
 * Context limits:
 * - `-500k` suffix in model ID → 500 000 tokens
 * - GPT models → 400 000 tokens (OpenAI's larger context)
 * - All others → 200 000 tokens
 *
 * Output limits use costTier as a proxy for model capability:
 * - Tier 1 (Haiku) → 8 000 tokens
 * - Tier 3 (Opus) → 32 000 tokens
 * - All others → 16 000 tokens
 */
function deriveLimits(modelId: string, model: AugmentModelInfo): ModelDefinition["limit"] {
  let context = 200000;
  if (modelId.endsWith("-500k")) {
    context = 500000;
  } else if (modelId.startsWith("gpt-")) {
    context = 400000;
  }

  let output = 16000;
  if (model.costTier === 1) {
    output = 8000;
  } else if (model.costTier === 3) {
    output = 32000;
  }

  return { context, output };
}

/**
 * Fetches the live model registry from Augment's `/get-models` endpoint.
 *
 * This mirrors Auggie's own model discovery path. The backend returns
 * `feature_flags.model_info_registry` as a JSON string whose object keys are the
 * actual model IDs accepted by `/chat-stream` and whose values contain display
 * metadata such as `displayName` and `shortName`.
 *
 * Returns `null` if the request fails or the registry is unavailable. The caller
 * leaves models unconfigured in that case so users can provide them explicitly.
 */
async function fetchAugmentModels(log: Logger): Promise<Record<string, ModelDefinition> | null> {
  try {
    const config = resolveConfigSync({}, log);
    const apiUrl = config.apiUrl.endsWith("/") ? config.apiUrl : `${config.apiUrl}/`;
    const endpoint = new URL("get-models", apiUrl);
    const response = await fetch(endpoint, {
      body: JSON.stringify({}),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": config.clientUserAgent ?? "opencode-augment-provider",
        "x-request-id": crypto.randomUUID(),
        "x-request-session-id": crypto.randomUUID(),
      },
      method: "POST",
    });

    if (!response.ok) {
      log.debug("Augment get-models failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const data = (await response.json()) as GetModelsResponse;
    const registryJson = data.feature_flags?.model_info_registry;
    if (!registryJson) {
      log.debug("Augment get-models response missing model_info_registry");
      return null;
    }

    const registry = JSON.parse(registryJson) as Record<string, AugmentModelInfo>;
    const models: Record<string, ModelDefinition> = {};

    for (const [modelId, model] of Object.entries(registry)) {
      models[modelId] = {
        name: model.displayName,
        limit: deriveLimits(modelId, model),
      };
    }

    if (Object.keys(models).length === 0) {
      log.debug("Augment model registry produced no supported models");
      return null;
    }

    log.debug("Fetched models from Augment get-models", { count: Object.keys(models).length });
    return models;
  } catch (err) {
    log.debug("Augment get-models threw", { error: String(err) });
    return null;
  }
}

/** Show a user-facing warning when automatic model discovery fails. */
async function notifyModelDiscoveryFailure(input: PluginInput, log: Logger): Promise<void> {
  try {
    await input.client.tui.showToast({
      body: {
        duration: 10000,
        message:
          "Could not discover Augment models from /get-models. Configure provider.augment.models manually if you need to continue.",
        title: "Augment model discovery failed",
        variant: "warning",
      },
    });
  } catch (err) {
    log.debug("Failed to show model discovery toast", { error: String(err) });
  }
}

/**
 * Creates an Augment provider for use with OpenCode, or registers an OpenCode
 * plugin when called by OpenCode's plugin loader.
 *
 * OpenCode calls this function in two contexts:
 *
 * **As a provider** — called by the provider loader with `AugmentProviderOptions`.
 * Returns a `ProviderV3` for the Vercel AI SDK:
 * ```typescript
 * const provider = createAugment();
 * const model = provider.languageModel('claude-sonnet-4-6');
 * ```
 *
 * **As a plugin** — called by the plugin loader with a `PluginInput` (has `client`).
 * Returns a `Hooks` object that injects `npm`, a `client.app.log`-backed logger,
 * and the live model registry from Augment's `/get-models` endpoint into the config:
 * ```json
 * { "plugin": ["file:///path/to/opencode-augment-provider"] }
 * ```
 *
 * The two call sites are distinguished by the presence of `client` in the argument,
 * which is always present in `PluginInput` and never present in `AugmentProviderOptions`.
 */
export function createAugment(input: PluginInput): Promise<Hooks>;
export function createAugment(options?: AugmentProviderOptions): ProviderV3;
export function createAugment(
  input: PluginInput | AugmentProviderOptions = {}
): Promise<Hooks> | ProviderV3 {
  if (isPluginInput(input)) {
    return createPlugin(input);
  }
  return createProvider(input);
}

/** Returns true when the argument is a `PluginInput` from OpenCode's plugin loader. */
function isPluginInput(input: PluginInput | AugmentProviderOptions): input is PluginInput {
  return "client" in input;
}

/**
 * Plugin path: injects `npm`, a `client.app.log`-backed logger, and — when no
 * models have been configured — the live model registry from `/get-models`
 * into the config so the subsequent provider call receives them.
 */
async function createPlugin(input: PluginInput): Promise<Hooks> {
  const logger: Logger = {
    debug(message: string, extra?: Record<string, unknown>) {
      void input.client.app.log({
        body: {
          extra,
          level: "debug",
          message,
          service: "augment-provider",
        },
      });
    },
  };

  return {
    config: async (config) => {
      if (!config.provider) config.provider = {};
      if (!config.provider.augment) config.provider.augment = {};
      if (!config.provider.augment.npm) config.provider.augment.npm = PACKAGE_ROOT;
      if (!config.provider.augment.options) config.provider.augment.options = {};
      if (!config.provider.augment.options.logger) config.provider.augment.options.logger = logger;

      // Only inject models when the user has not configured any.
      const models = config.provider.augment.models;
      if (!models || Object.keys(models).length === 0) {
        const liveModels = await fetchAugmentModels(logger);
        if (liveModels) {
          config.provider.augment.models = liveModels;
        } else {
          logger.debug("Augment model discovery unavailable; leaving models unconfigured");
          await notifyModelDiscoveryFailure(input, logger);
        }
      }
    },
  };
}

/**
 * Provider path: returns a `ProviderV3` implementation for the Vercel AI SDK.
 */
function createProvider(options: AugmentProviderOptions): ProviderV3 {
  const log = options.logger ?? createStderrLogger();
  log.debug("createAugment called");

  return {
    specificationVersion: "v3" as const,

    languageModel(modelId: string): LanguageModelV3 {
      log.debug("Creating language model", { modelId });
      const config = resolveConfigSync(options, log);
      return new AugmentLanguageModel(modelId, config, log);
    },

    embeddingModel(modelId: string): never {
      throw new Error(`Augment provider does not support embedding models: ${modelId}`);
    },

    imageModel(modelId: string): never {
      throw new Error(`Augment provider does not support image models: ${modelId}`);
    },
  };
}

/**
 * Creates the default stderr-based logger.
 *
 * Writes to `process.stderr` rather than `console.debug` so that output is
 * never captured by the TUI's stdout rendering. OpenCode controls whether
 * debug output is shown based on its own log-level configuration.
 */
function createStderrLogger(): Logger {
  return {
    debug(message: string, extra?: Record<string, unknown>): void {
      const parts = ["[augment-provider]", message];
      if (extra && Object.keys(extra).length > 0) {
        parts.push(JSON.stringify(extra));
      }
      process.stderr.write(`${parts.join(" ")}\n`);
    },
  };
}

/**
 * Resolves Augment credentials synchronously.
 *
 * Resolution order:
 * 1. Explicit options (apiKey, apiUrl)
 * 2. Environment variables (AUGMENT_API_KEY, AUGMENT_API_URL)
 * 3. Session file (~/.augment/session.json)
 *
 * @throws Error if no valid credentials can be found
 */
function resolveConfigSync(
  options: AugmentProviderOptions,
  log: Logger
): AugmentLanguageModelConfig {
  if (options.apiKey) {
    log.debug("Using API key from options");
    return {
      apiKey: options.apiKey,
      apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    };
  }

  const envApiKey = process.env.AUGMENT_API_KEY;
  if (envApiKey) {
    log.debug("Using API key from environment");
    return {
      apiKey: envApiKey,
      apiUrl: process.env.AUGMENT_API_URL ?? DEFAULT_API_URL,
    };
  }

  if (cachedConfig) {
    log.debug("Using cached config");
    return cachedConfig;
  }

  const sessionPath = path.join(os.homedir(), ".augment", "session.json");
  log.debug("Reading session file", { path: sessionPath });

  try {
    const sessionData = fs.readFileSync(sessionPath, "utf-8");
    const session: AugmentSession = JSON.parse(sessionData);

    if (!session.accessToken || !session.tenantURL) {
      throw new Error("Session file missing accessToken or tenantURL");
    }

    cachedConfig = {
      apiKey: session.accessToken,
      apiUrl: session.tenantURL,
    };
    log.debug("Loaded credentials from session file");
    return cachedConfig;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    const hint =
      error.code === "ENOENT" ? 'Run "auggie login" or set AUGMENT_API_KEY' : error.message;
    throw new Error(`Failed to resolve Augment credentials: ${hint}`);
  }
}
