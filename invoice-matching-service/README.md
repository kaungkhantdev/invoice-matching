# Invoice Matching Service

Reads supplier invoices in any format (PDF, photo, iPhone HEIC, SVG, Excel, CSV, InvoiceNow XML), turns each one into **our standard invoice**, matches it to its PO (**screenshots of the PO page in our system**, uploaded together with the invoice), and sorts it: **Matched** · **Matched with a note** · **Review** (a person looks).

> **Textract reads. Bedrock understands. Rules decide.** The AI only copies what's on the invoice. Every pass/fail is plain, explainable code.

More detail: [System design](../docs/SYSTEM-DESIGN.md) · [Infrastructure on AWS](../docs/INFRASTRUCTURE-AWS.md)

Two projects, each on its own (its own `package.json`, `.env` and Dockerfile), so each can move to a repo of its own:

| Folder | What it is | Its `.env` |
|---|---|---|
| [`api/`](api/README.md) | The backend (NestJS): **all business logic**, the data (`data/`, `samples/`) and the results (`output/`) | The AWS login and every setting. **Secret** |
| [`web/`](web/README.md) | The page (React + Vite): **only shows** what the API returns | Only `API_URL`: where the API runs. No secrets |
| `compose.yaml` | Runs both in Docker | |

```
browser ──► page (web/) ──/api/…──► API (api/) ──► Textract + Bedrock (Singapore)
            :5173                    :3000          data/ (suppliers) · output/ (uploads, results)
            Docker: :8080
```

The page calls `/api` on its own address, and its server forwards that to the API (Vite on your computer, nginx in Docker). So the browser talks to one address only, and the API needs no CORS.

---

## Run it

| Way | Use it when | Open |
|---|---|---|
| **A. On this computer** | Normal use and working on the code (the page reloads as you edit) | http://localhost:5173 |
| **B. Docker** | No Node.js on the computer | http://localhost:8080 |

Both are for **this computer only**: the API refuses other addresses on purpose.

### A. On this computer

Needs **Node 24 or newer** (`node -v`). Set up before the split, with your keys in `invoice-matching-service/.env`? Move that file first, so the keys go to the API:

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service && mv -n .env api/.env
```

The first time (and after pulling new code), set up both projects (`-n` never overwrites an `.env` that already holds your keys):

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service/api && npm install && cp -n .env.example .env
```

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service/web && npm install && cp -n .env.example .env
```

Put the AWS keys in **`api/.env`** ([AWS login](api/README.md#aws-login)).

Then two terminals. The **API**:

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service/api && npm start
```

The **page**:

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service/web && npm run dev
```

Open **http://localhost:5173**. Changes in `web/src/` show at once; after changing `api/`, stop the API (Ctrl+C) and start it again.

### B. Docker

Needs Docker (Docker Desktop or OrbStack); no Node.js needed. The first time, make `api/.env` and put the AWS keys in it:

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service && cp -n api/.env.example api/.env
```

Then:

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service && docker compose up --build
```

Open **http://localhost:8080**. Stop with Ctrl+C.

- Two containers: the page (nginx, published on port 8080) and the API (reached only through the page).
- The AWS keys and settings come from `api/.env` when the containers are created. After changing `api/.env`, stop (Ctrl+C) and run `docker compose up` again (`docker compose restart` keeps the old values).
- `compose.yaml` fixes `PORT`, `HOST`, `UI_STORE_DIR` and `WEB_ORIGINS`, whatever `api/.env` says, and `DATA_DIR` too: set that on the command line (`DATA_DIR=… docker compose up`).
- `api/data/` is shared with the container: edit it, then click **Re-check all**.
- Uploads and results are kept between restarts. To delete them too: `docker compose down -v`.

---

## Use it

Every invoice comes in **with its PO**: that is the only way to add one, so you always know which PO each invoice in the list was checked against.

1. The top line shows **Amazon Bedrock · anthropic.claude-sonnet-5 · Singapore (ap-southeast-1) · OCR: Amazon Textract**. The dot is green when an AWS login is found.
2. In our system, open the PO (**Recurring PO Details**) and take screenshots: the top (PO number, supplier, site, contract) and the items down to the **Grand Total**. Overlapping is fine.
3. Click **Match an invoice with its PO** (the orange button at the top right). Drop the screenshots in **1. PO details** and the supplier's invoice in **2. Supplier invoice**, then **Match**.
4. Bedrock reads the PO (about 8 s), then the invoice is read (Textract + Bedrock) and checked against **that** PO.
5. Click the invoice to see the 7 checks, invoiced vs PO per line, the PO as read with its screenshots, and the original file (eye icon). **Approve** or **Reject** it; **Read again** reads both again.

| On the PO | Must match |
|---|---|
| PO number | The PO quoted on the invoice (not quoted: a note) |
| Supplier | The invoice's supplier ("Rentokil Initial (S)" = "Rentokil Initial Singapore") |
| Status | APPROVED |
| Delivery site | The invoice's site, or its signed service records |
| Contract start – end | The month the invoice is for |
| Each item's **Total** (a month) | The invoice line's amount. Quantities aren't compared: the PO counts visits (10.5 bi-monthly), the invoice counts items (21) |
| Grand Total | The invoice's subtotal |

The PO itself must add up (quantity × unit price = total, items = grand total), or check 2 says what doesn't. A recurring PO is billed once a month. The supplier must still be in `api/data/suppliers.json` (check 6: UEN, GST no., bank account).

**Real example:** PO GEN000073 (`~/Desktop/research/invoice-type/PO/`, 2 screenshots) with `~/Desktop/research/invoice-type/Rentokil 0021490975.pdf`: all 9 charged lines match (Dual Paper 26.67 vs 26.66 a month: a note), and it goes to **Review** only because the invoice is for October and the contract starts on 5 November 2026.

Suppliers, the API's requests, its settings and the code map: [api/README.md](api/README.md).

## Troubleshooting

| You see | Do this |
|---|---|
| Red dot, "No AWS login found" | Set the two AWS keys in `api/.env` (or `AWS_PROFILE`, not in Docker), restart the API (Docker: Ctrl+C, then `docker compose up`), then click **Read again** on invoices that already went to Review |
| "…(wrong or expired keys?)" | Check the keys in `api/.env`, restart the API (as above), then **Read again** |
| "…may not use anthropic.claude-sonnet-5" | Give the login `bedrock:InvokeModel`, and check Claude Sonnet 5 in the Bedrock console (Singapore) |
| "…may not use textract:AnalyzeExpense" | Give the login that permission |
| "Bedrock … busy" or "Textract … busy" | Retried by itself (30 s, then 60 s). If it keeps happening, ask AWS to raise the quota (Textract: then raise `TEXTRACT_TPS`) |
| Check 0 note "Textract couldn't read all of it" | Textract couldn't read that page (or a broken PDF); Claude read it alone. Look at the file |
| "Forbidden: open the page at http://localhost:5173" | Use exactly that address. If the page runs at another address, add it to `WEB_ORIGINS` in `api/.env` |
| Page shows "Can't reach the server" | Start the API too (`cd api && npm start`), on the port in `web/.env` (`API_URL`) |
| Port 3000 in use | `PORT=3001 npm start` in `api/`, and `API_URL=http://localhost:3001 npm run dev` in `web/`; open http://localhost:5173 as before |
| Port 5173 in use | `npm run dev -- --port 5174` in `web/`, and `WEB_ORIGINS=http://localhost:5174 npm start` in `api/`; open http://localhost:5174 |
| Port 8080 in use (Docker) | Stop whatever uses it, or change every `8080` in `compose.yaml` (the published port and both `WEB_ORIGINS` addresses) |

## Measured on this Mac (Apple M5, 24 GB)

| What | Result |
|---|---|
| 700 invoices waiting in the queue (stand-in AI, 8 at a time, 10% "busy" errors) | All 700 done in 44 s, never more than 8 at once, all 70 errors retried |
| 5 sample invoices read live in Singapore (Textract + Bedrock; Excel: Bedrock only) | 3–11 s each (Excel 3 s; PDF, photos and SVG 5–11 s). Cost per invoice not measured yet |
| PO GEN000073 (2 screenshots, Bedrock) + Rentokil 0021490975 (8-page PDF, Textract + Bedrock), live | PO 8 s, invoice 32 s; all 9 PO items read once from the overlapping screenshots |
