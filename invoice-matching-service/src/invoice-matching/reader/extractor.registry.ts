import { Injectable } from "@nestjs/common";
import { config, type AiProvider } from "../config.js";
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

/**
 * Both AIs, created when first used. AI_PROVIDER picks the default; a run can ask for the other one.
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
      extractor = provider === "local" ? new LocalLlmExtractor() : new ClaudeExtractor();
      this.cache.set(provider, extractor);
    }
    return extractor;
  }

  /** Is each AI usable right now? (Claude: key set. Local: server answers and has the model.) */
  async status(): Promise<ProviderStatus[]> {
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    const claude: ProviderStatus = {
      provider: "claude",
      model: config.claude.model,
      ready: hasKey,
      hint: hasKey ? "API key set" : "Set ANTHROPIC_API_KEY in .env and restart",
    };
    return [claude, await this.localStatus()];
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
