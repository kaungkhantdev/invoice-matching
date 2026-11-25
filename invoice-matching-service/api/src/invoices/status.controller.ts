import { Controller, Get } from "@nestjs/common";
import { config } from "../config.js";
import { awsLoginFound, regionName } from "../matching/reader/aws.js";
import { ACCEPTED, InvoiceStore, MAX_FILE_BYTES, MAX_PO_FILES, PO_ACCEPTED } from "./invoice-store.service.js";

const NO_LOGIN_HINT =
  "No AWS login found: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the API's .env (or AWS_PROFILE), then restart the API";

/** What reads the invoices, whether it is set up, and how full the queue is. */
@Controller("status")
export class StatusController {
  constructor(private readonly store: InvoiceStore) {}

  @Get()
  status() {
    const loginFound = awsLoginFound();
    return {
      ai: { name: "Amazon Bedrock", model: config.bedrock.model, region: regionName(config.bedrock.region) },
      ocr: { name: "Amazon Textract", region: regionName(config.textract.region) },
      // A quick local look: whether the login really works shows on the first read.
      awsLogin: loginFound ? "found" : "missing",
      hint: loginFound ? null : NO_LOGIN_HINT,
      queue: this.store.queueStats(),
      /** What the upload accepts: the page skips bigger files itself, so one big file doesn't stop the others. */
      upload: {
        accept: [...ACCEPTED].join(","),
        maxBytes: MAX_FILE_BYTES,
        /** For the PO uploaded with an invoice: screenshots of our system's PO page, or a PDF printout. */
        poAccept: [...PO_ACCEPTED].join(","),
        maxPoFiles: MAX_PO_FILES,
      },
    };
  }
}
