import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { BatchService } from "./invoice-matching/batch.service.js";
import { InvoiceMatchingModule } from "./invoice-matching/invoice-matching.module.js";

// Usage: npm run match -- [inputFolder] [outputFolder]
const inputDir = process.argv[2] ?? "samples/invoices";
const outputDir = process.argv[3] ?? "output";

const app = await NestFactory.createApplicationContext(InvoiceMatchingModule, { logger: ["error", "warn"] });
try {
  await app.get(BatchService).run(inputDir, outputDir);
} finally {
  await app.close();
}
