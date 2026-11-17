import { Module } from "@nestjs/common";
import { AccountingSource, JsonAccountingSource } from "./accounting/accounting.source.js";
import { BatchService } from "./batch.service.js";
import { CheckerService } from "./checker/checker.service.js";
import { config } from "./config.js";
import { MatchingService } from "./matching.service.js";
import { ExtractorRegistry } from "./reader/extractor.registry.js";
import { ReaderService } from "./reader/reader.service.js";
import { XmlReader } from "./reader/xml.reader.js";

/**
 * Drop this module into the main NestJS app.
 * - AI_PROVIDER=claude | local picks the default AI that reads PDFs, photos and spreadsheets.
 * - To use the real accounting system, swap JsonAccountingSource for a class that calls its API.
 */
@Module({
  providers: [
    XmlReader,
    ExtractorRegistry,
    ReaderService,
    CheckerService,
    MatchingService,
    BatchService,
    { provide: AccountingSource, useFactory: () => new JsonAccountingSource(config.dataDir) },
  ],
  exports: [ReaderService, CheckerService, MatchingService, BatchService, ExtractorRegistry, AccountingSource],
})
export class InvoiceMatchingModule {}
