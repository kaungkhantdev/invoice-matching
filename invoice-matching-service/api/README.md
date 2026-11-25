# Invoice Matching API

The backend (NestJS): **all business logic**. It reads each invoice (InvoiceNow XML, or Textract + Claude on Bedrock), reads the PO from its screenshots, runs the 7 checks, and keeps the list of invoices. The page is a separate project, **web** (beside this one: [`../web`](../web/README.md)), that only shows what this API returns.

Running both together, and what the page shows: the README in the folder that holds both projects ([`../README.md`](../README.md)).

## Set up

Needs **Node 24 or newer** (`node -v`).

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service/api
```

The first time only (`-n` never overwrites an `.env` that already holds your keys):

```bash
cp -n .env.example .env
```

```bash
npm install
```

## AWS login

Every PDF page, photo and SVG is read in two steps, both in **Singapore**:

1. **Amazon Textract** reads the text (OCR).
2. **Claude on Amazon Bedrock** (Claude Sonnet 5) looks at the file and Textract's text together, and fills in our standard invoice.

XML (InvoiceNow) invoices need neither. Excel and CSV skip Textract (there is no image).

Put the IAM user's keys in this folder's `.env`:

```
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
```

Or the name of an AWS CLI profile instead: `AWS_PROFILE=…` (not both; Docker needs the two keys). Keep `.env` private: never share, zip or commit it (it is in `.gitignore` and never goes into the Docker image).

The AWS side needs:
- the permissions `textract:AnalyzeExpense` and `bedrock:InvokeModel`;
- **Claude Sonnet 5** available to the account in the Bedrock console (Asia Pacific, Singapore);
- **before real invoices:** an AWS Organizations **AI services opt-out policy** for `textract` (otherwise AWS may keep invoice images to improve its service).

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build and start the API on http://localhost:3000/api (check: http://localhost:3000/api/status). After changing code, stop it (Ctrl+C) and start it again |
| `npm test` | 147 tests; no AWS or internet needed (Bedrock and Textract are replaced by stand-ins) |
| `npm run build` | Build without starting |
| `npm run match -- path/to/folder` | Match every file in a folder against the POs keyed in `data/purchase-orders.json` (no screenshots); writes `output/results.json` and `output/summary.csv`. Not shown on the page |
| `npm run samples` | Draw the 7 sample invoices in `samples/invoices/` again (for `npm run match`; the page doesn't use them). Only needed after changing `scripts/` (sample 07, the HEIC photo, needs a Mac) |

## Docker

With the page: `docker compose up --build` in the folder that holds both projects. The API alone, on http://localhost:3000/api (for the page's `npm run dev`):

```bash
docker build -t invoice-matching-api . && docker run --rm --env-file .env -v invoice-results:/app/output -p 127.0.0.1:3000:3000 invoice-matching-api
```

The settings come from `.env` when the container is created (`-v` keeps uploads and results between runs).

## The API

All under `/api`. Only the two marked **AI** call AWS (Textract + Bedrock); they answer at once and the reading happens in the queue.

| Request | AI | What it does |
|---|---|---|
| `POST /api/invoices/with-po` | **AI** | The only way to add an invoice: one supplier invoice with its PO. Form fields `po` (1 to 5 screenshots of the PO page, or a PDF of it) and `invoice` (up to 25 MB each) |
| `POST /api/invoices/:id/reread` | **AI** | Read the file again (and its PO, if one was uploaded) |
| `GET /api/status` | | What reads the invoices, whether an AWS login is set up (a local look, no AWS call), the queue, the upload limits |
| `GET /api/invoices` | | The list |
| `GET /api/invoices/:id` | | One invoice: what was read, the 7 checks, invoiced vs PO per line |
| `GET /api/invoices/:id/file` | | The original file |
| `GET /api/invoices/:id/preview?page=1` | | The file as a JPEG (PDF pages, photos), made on this computer |
| `GET /api/invoices/:id/po/1/file` · `…/po/1/preview` | | The first PO screenshot uploaded with it (then `2`, `3`…) |
| `POST /api/invoices/:id/decision` | | Approve or reject: `{ "decision": "APPROVED", "note": "…", "outcome": "<result you saw>" }` |
| `POST /api/recheck` | | Reload `data/` and run every check again (rules only) |
| `DELETE /api/invoices` | | Clear the list |

**Who may call it:** only a browser on this computer, on the page's address (`WEB_ORIGINS`) or the API's own. The page's server forwards `/api` here, so the API needs no CORS. Requests without an `Origin` header (curl) pass if they are addressed to `localhost`.

## Suppliers and recorded invoices

Edit the files in `data/` (copy the format of the entries there):

| File | What goes in it |
|---|---|
| `suppliers.json` | Each supplier: id, name, UEN, GST reg. no. (or null), bank account (or a list, if it has several). Check 6 needs the invoice's supplier here |
| `recorded-invoices.json` | Invoices already recorded or paid: supplier id, invoice number, and the **PO number** it billed (check 5: not paid twice) |
| `purchase-orders.json` | POs keyed by hand, for `npm run match` only (the page always uses the PO uploaded with the invoice). Each PO: number, supplier id, currency, **site** and **period** (`YYYY-MM`), lines |

Then click **Re-check all** on the page (the circular arrow): it reloads the data and runs every check again, in about a second. Starting the API does the same.

`examples/icfm/` holds Rentokil and Masandao with two example keyed POs, for `npm run match` (see its README).

## Settings

Set in this folder's `.env`. Only the AWS login is needed; everything else has a working default. A setting that's missing or left blank (`GST_RATE=`, nothing after the `=`) uses its default. If `GST_RATE`, `ROUNDING_TOLERANCE` or `WEB_ORIGINS` is mistyped (`GST_RATE=9%`), the API stops at start and names the setting. A setting given on the command line (`PORT=3001 npm start`) wins over `.env`.

| Setting | Default | What it does |
|---|---|---|
| `BEDROCK_MODEL` | `anthropic.claude-sonnet-5` | Claude Sonnet 5 runs **In-Region in Singapore**. `global.anthropic.claude-opus-5-5` is newer but "Global": invoices may leave Singapore |
| `BEDROCK_REGION` / `TEXTRACT_REGION` | `ap-southeast-1` | Not taken from `AWS_REGION`, on purpose |
| `BEDROCK_EFFORT` | `medium` | How hard Claude thinks: `low`, `medium` or `high` |
| `BEDROCK_CONCURRENCY` | `8` | Invoices read at the same time (raise it if your Bedrock quota allows) |
| `TEXTRACT_TPS` | `1` | Textract requests per second your AWS quota allows (Singapore default: 1) |
| `TEXTRACT_MAX_PAGES` | `5` | PDF pages sent to Textract; later pages get a note in check 0 (Claude still reads the whole PDF) |
| `READ_MAX_ATTEMPTS` | `3` | The page only: tries when Textract or Bedrock is busy or unreachable (30 s, 60 s…), then Review. `npm run match` doesn't retry |
| `BUYER_NAMES` | `Industrial & Commercial Facilities Management Pte Ltd` | Our company name(s), separated by a vertical bar (\|). Every invoice must be billed to one of them |
| `GST_RATE` / `ROUNDING_TOLERANCE` | `0.09` / `1.00` | Singapore GST; differences up to the tolerance are "matched with a note" |
| `LINE_MATCH_MIN_SCORE` | `0.5` | How similar (0–1) an invoice line must be to a PO line to count as the same item |
| `PORT` | `3000` | The API's port. If you change it, set the page's `API_URL` to match (in the page's `.env`). Docker always uses 3000 inside |
| `HOST` | `127.0.0.1` | Address the API listens on. Docker uses `0.0.0.0` inside the container (set in `compose.yaml`); still this computer only |
| `WEB_ORIGINS` | `http://localhost:5173\|http://127.0.0.1:5173` | Where the page is opened, separated by \|. The API answers browsers on these addresses only. Docker sets `http://localhost:8080\|http://127.0.0.1:8080` |
| `DATA_DIR` / `UI_STORE_DIR` | `data` / `output/ui` | Where suppliers and POs are read from; where uploads and results are kept. With `compose.yaml`, set `DATA_DIR` on the command line (`DATA_DIR=examples/icfm docker compose up`): `.env` doesn't reach it there |

## Finding your way in the code

Follow one invoice from upload to result:

| Step | Where |
|---|---|
| 1. Upload arrives, waits in the queue | `src/invoices/invoices.controller.ts` → `invoice-store.service.ts` |
| 2. Read the files (the PO's screenshots: Bedrock; the invoice: XML, or Textract + Bedrock) | `src/matching/reader/reader.service.ts` |
| 3. Clean up what was read | `src/matching/normalize/` |
| 4. Find the supplier and check the PO uploaded with it (`npm run match`: a PO keyed in `data/`) | `src/matching/matching.service.ts` → `uploaded-po.ts`, `po-lookup.ts`, `accounting/` |
| 5. Run the 7 checks | `src/matching/checker/checks/0-…` to `6-…` (one file each) |
| 6. Shape the answer for the page | `src/invoices/invoice.view.ts` |
| 7. Show it | the page: the **web** project ([`../web`](../web/README.md)) |

| Folder | What's in it |
|---|---|
| `src/` | The API. `src/matching/` holds the rules; `src/invoices/` the HTTP API and the invoice queue; `config.ts` every setting |
| `test/` | The tests (`npm test`) |
| `data/` · `examples/icfm/` | Suppliers, keyed POs, recorded invoices |
| `samples/invoices/` · `scripts/` | The 7 sample invoices, and the script that draws them |
| `output/` | Uploads and results (not in git) |
