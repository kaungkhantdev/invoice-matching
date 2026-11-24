import { Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, type AiProvider } from "../config.js";
import { BedrockExtractor } from "./bedrock.extractor.js";
import { ClaudeExtractor } from "./claude.extractor.js";
import type { InvoiceExtractor } from "./extractor.js";
import { LocalLlmExtractor } from "./local-llm.extractor.js";

export interface ProviderStatus {
  provider: AiProvider;
  model: string;
  ready: boolean;
  /** What to do if it isn't ready, in plain words. */
  hint: string;
}

/** "ap-southeast-1" → "Singapore (ap-southeast-1)". */
export const regionName = (region: string) => (region === "ap-southeast-1" ? `Singapore (${region})` : region);

/**
 * Is an AWS login set up here? (Bedrock and Textract both need one.) A quick local look only: whether it is
 * still valid (e.g. an expired SSO session) shows on the first read, with a plain-words error.
 */
export function awsLoginFound(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const fromEnv = [
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  ].some((name) => Boolean(env[name]));
  return fromEnv || existsSync(join(home, ".aws", "credentials")) || existsSync(join(home, ".aws", "config"));
}

/**
 * All AIs, created when first used. AI_PROVIDER picks the default; a run can ask for another one.
 */
@Injectable()
export class ExtractorRegistry {
  private readonly cache = new Map<AiProvider, InvoiceExtractor>();

  get defaultProvider(): AiProvider {
    return config.aiProvider;
  }

  get(provider: AiProvider = config.aiProvider): InvoiceExtractor {
    let extractor = this.cache.get(provider);
    if (!extractor) {
      extractor =
        provider === "bedrock" ? new BedrockExtractor() : provider === "local" ? new LocalLlmExtractor() : new ClaudeExtractor();
      this.cache.set(provider, extractor);
    }
    return extractor;
  }

  /** Is each AI usable right now? (Bedrock: AWS login set up. Claude: key set. Local: server answers and has the model.) */
  async status(): Promise<ProviderStatus[]> {
    const aws = awsLoginFound();
    const bedrock: ProviderStatus = {
      provider: "bedrock",
      model: config.bedrock.model,
      ready: aws,
      hint: aws ? regionName(config.bedrock.region) : 'No AWS login found: run "aws configure" or "aws sso login"',
    };
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    const claude: ProviderStatus = {
      provider: "claude",
      model: config.claude.model,
      ready: hasKey,
      hint: hasKey ? "API key set" : "Set ANTHROPIC_API_KEY in .env and restart",
    };
    return [bedrock, claude, await this.localStatus()];
  }

  private async localStatus(): Promise<ProviderStatus> {
    const { baseUrl, model, apiKey } = config.local;
    const base = { provider: "local" as const, model };
    if (config.local.api === "ollama") return this.ollamaStatus();
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return { ...base, ready: false, hint: `Server at ${baseUrl} answered ${res.status}` };
      const body = (await res.json()) as { data?: { id?: string }[] };
      const ids = (body.data ?? []).map((m) => m.id ?? "");
      const found = ids.some((id) => id === model || id === `${model}:latest` || `${id}:latest` === model);
      return found
        ? { ...base, ready: true, hint: `Running at ${baseUrl}` }
        : { ...base, ready: false, hint: `Server is running but has no "${model}" (Ollama: ollama pull ${model})` };
    } catch {
      return { ...base, ready: false, hint: `No server at ${baseUrl} (start Ollama: ollama serve)` };
    }
  }

  /** Ollama also says whether the model can see images (photos and scans need that). */
  private async ollamaStatus(): Promise<ProviderStatus> {
    const { baseUrl, model } = config.local;
    const origin = baseUrl.replace(/\/v1$/, "");
    const base = { provider: "local" as const, model };
    try {
      const res = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return { ...base, ready: false, hint: `Ollama at ${origin} answered ${res.status}` };
      const body = (await res.json()) as { models?: { name?: string; model?: string; capabilities?: string[] }[] };
      const sameTag = (a = "", b = "") => a === b || a === `${b}:latest` || b === `${a}:latest`;
      const found = (body.models ?? []).find((m) => sameTag(m.name, model) || sameTag(m.model, model));
      if (!found) return { ...base, ready: false, hint: `Ollama has no "${model}": run  ollama pull ${model}` };
      if (found.capabilities && !found.capabilities.includes("vision")) {
        return { ...base, ready: true, hint: `Text only: "${model}" can't read photos or scans, pick a vision model` };
      }
      return { ...base, ready: true, hint: `Ollama at ${origin}` };
    } catch {
      return { ...base, ready: false, hint: `Ollama isn't running at ${origin} (open the Ollama app)` };
    }
  }
}
