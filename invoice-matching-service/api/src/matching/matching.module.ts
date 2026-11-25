import { Module } from "@nestjs/common";
import { AccountingSource, JsonAccountingSource } from "./accounting/accounting.source.js";
import { BatchService } from "./batch.service.js";
import { CheckerService } from "./checker/checker.service.js";
import { config } from "../config.js";
import { MatchingService } from "./matching.service.js";
import { ReaderService } from "./reader/reader.service.js";
import { XmlReader } from "./reader/xml.reader.js";

/**
 * The business rules: read (Textract + Bedrock, or InvoiceNow XML), check, match. No HTTP here.
 * To use the real accounting system, swap JsonAccountingSource for a class that calls its API.
 */
@Module({
  providers: [
    XmlReader,
    ReaderService,
    CheckerService,
    MatchingService,
    BatchService,
    { provide: AccountingSource, useFactory: () => new JsonAccountingSource(config.dataDir) },
  ],
  exports: [ReaderService, CheckerService, MatchingService, BatchService, AccountingSource],
})
export class MatchingModule {}
