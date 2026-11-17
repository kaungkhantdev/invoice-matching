import { Injectable } from "@nestjs/common";
import { extname } from "node:path";
import type { AiProvider } from "../config.js";
import type { ReadBy, StandardInvoice } from "../invoice.schema.js";
import { ExtractorRegistry } from "./extractor.registry.js";
import { prepareForAi } from "./file-prep.js";
import { XmlReader } from "./xml.reader.js";

/**
 * READ step: any file in, OUR standard invoice out.
 *   XML (InvoiceNow)                      → read directly, no AI
 *   PDF / photo / scan / SVG / Excel / CSV → Claude or the local LLM (AI_PROVIDER, or chosen per run)
 */
@Injectable()
export class ReaderService {
  constructor(
    private readonly xml: XmlReader,
    private readonly extractors: ExtractorRegistry,
  ) {}

  /** e.g. "local LLM gemma4:12b" — for logs and reports. */
  describeAi(provider: AiProvider = this.extractors.defaultProvider): string {
    const ai = this.extractors.get(provider);
    return ai.provider === "local" ? `local LLM ${ai.model}` : `Claude API ${ai.model}`;
  }

  async read(
    fileName: string,
    data: Buffer,
    provider?: AiProvider,
  ): Promise<{ invoice: StandardInvoice; readBy: ReadBy; model: string | null }> {
    const ext = extname(fileName).toLowerCase();
    if (ext === ".xml") return { invoice: this.xml.parse(data.toString("utf8")), readBy: "xml", model: null };
    const ai = this.extractors.get(provider);
    const prepared = await prepareForAi(ext, data);
    return { invoice: await ai.extract(fileName, prepared), readBy: ai.provider, model: ai.model };
  }
}
