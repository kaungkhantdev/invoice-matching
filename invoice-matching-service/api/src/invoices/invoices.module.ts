import { Module } from "@nestjs/common";
import { MatchingModule } from "../matching/matching.module.js";
import { InvoiceStore } from "./invoice-store.service.js";
import { InvoicesController } from "./invoices.controller.js";
import { StatusController } from "./status.controller.js";

/** The HTTP API (under /api) behind the React page, and the invoice queue. Uses the matching rules. */
@Module({
  imports: [MatchingModule],
  controllers: [InvoicesController, StatusController],
  providers: [InvoiceStore],
})
export class InvoicesModule {}
