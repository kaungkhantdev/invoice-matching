import { Module } from "@nestjs/common";
import { InvoiceMatchingModule } from "../invoice-matching/invoice-matching.module.js";
import { InvoiceStore } from "./invoice-store.service.js";
import { InvoicesController } from "./invoices.controller.js";

/** The review page and its API. In the main app this becomes the finance team's review screen. */
@Module({
  imports: [InvoiceMatchingModule],
  controllers: [InvoicesController],
  providers: [InvoiceStore],
})
export class UiModule {}
