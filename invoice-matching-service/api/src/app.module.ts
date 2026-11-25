import { Module } from "@nestjs/common";
import { InvoicesModule } from "./invoices/invoices.module.js";

/**
 * The whole backend. All business logic lives here, in two feature modules:
 *   matching/  the rules: read (Textract + Bedrock, or InvoiceNow XML), the 7 checks, matching to the keyed PO
 *   invoices/  the HTTP API under /api and the invoice queue
 * The React app in web/ only shows the page and calls this API.
 */
@Module({ imports: [InvoicesModule] })
export class AppModule {}
