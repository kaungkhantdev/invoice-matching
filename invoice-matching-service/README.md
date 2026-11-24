# Invoice Matching Service

Reads supplier invoices in any format (PDF, photo, iPhone HEIC, SVG, Excel, CSV, InvoiceNow XML), turns each one into **our standard invoice**, checks it against the PO and the delivery, and sorts it: **Matched** · **Matched with a note** · **Review** (a person looks).

> **Textract reads. Bedrock understands. Rules decide.** The AI only copies what's on the invoice. Every pass/fail is plain, explainable code.

More detail: [System design](../docs/SYSTEM-DESIGN.md) · [Infrastructure on AWS](../docs/INFRASTRUCTURE-AWS.md)

---

## Setup (Mac, about 15 minutes)

### 1. Install Node.js

**Node 24 or newer** (the PDF library needs it). Check with:

```bash
node -v
```

It should print v24 or higher. If it's missing or older, install the current LTS version from nodejs.org.

### 2. Install the project

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service
```

```bash
npm install
```

```bash
cp .env.example .env
```

### 3. Log in to AWS (Textract + Bedrock)

Every PDF page and photo is read in two steps, both in **Singapore**:

1. **Amazon Textract** reads the text (OCR).
2. **Claude on Amazon Bedrock** (Claude Sonnet 5) looks at the file and Textract's text together, and fills in our standard invoice.

XML (InvoiceNow) invoices need neither. Excel and CSV skip Textract (there is no image) and go straight to Claude.

1. Install the AWS CLI from aws.amazon.com/cli, then log in:
   ```bash
   aws configure
   ```
   If your company uses AWS SSO, run `aws sso login` instead.
2. The login needs two permissions: `textract:AnalyzeExpense` and `bedrock:InvokeModel`.
3. In the **Bedrock console**, region **Asia Pacific (Singapore)**, check that **Claude Sonnet 5** is available to your account (Model catalog).
4. **Before using real invoices:** by default AWS may keep Textract inputs to improve its services. Ask your AWS admin to attach an **AI services opt-out policy** for `textract` in AWS Organizations.

Then tell the app which login to use, in `.env` (copy `.env.example` first). Use **one** of these, not both:

- **A profile** (keys stay in `~/.aws`, outside the project): `AWS_PROFILE=your-profile-name`
- **The keys themselves**: `AWS_ACCESS_KEY_ID=…` and `AWS_SECRET_ACCESS_KEY=…`. Keep `.env` private: never share, zip or commit it (it is in `.gitignore`).

Bedrock and Textract in Singapore are the defaults. The region is fixed to Singapore on purpose (an `AWS_REGION` set for other work doesn't move invoices elsewhere).

**Trying it without AWS?** Pick another AI in `.env`:

- **Claude API:**
  ```
  TEXTRACT=off
  AI_PROVIDER=claude
  ANTHROPIC_API_KEY=your-key
  ```
- **Local model with Ollama** (invoices stay on this Mac: Textract is never used with it):
  1. Install Ollama **0.34.1 or newer** from ollama.com/download. Older versions read small print in photos poorly.
  2. Download a vision model (about 8 GB):
     ```bash
     ollama pull gemma4:12b
     ```
  3. Keep the Ollama app running (llama icon in the menu bar). Then set:
     ```
     AI_PROVIDER=local
     ```
  To use LM Studio, vLLM or llama.cpp instead, see [Settings](#settings).

### 4. Make the 7 sample invoices

```bash
npm run samples
```

### 5. Start the review page

```bash
npm run ui
```

Open **http://localhost:3000**. The page only works on this computer.

### 6. Try it

1. Next to **Read with**, keep **Amazon Bedrock** (or pick Claude API / Local LLM). The dot turns green when an AWS login (or key, or server) is found. The line also shows **OCR: Amazon Textract** (or "no OCR" for the Local LLM, which keeps everything on this Mac).
2. Click the **document icon** at the top right to run the 7 sample invoices. Or press **+**, or drag files onto the page, to upload your own.
3. Click any invoice to see:
   - the 7 checks and why each one passed or failed
   - invoiced vs received for each line
   - what was read, compared with your records
   - the original file (eye icon)
4. **Approve** or **Reject** it. **Read again** reads the same file with the AI you pick (not for XML). The new result replaces the old one and clears any Approve/Reject, so note the first result if you want to compare.

What the 7 samples should show: 01 matched, 02 price too high, 03 matched (photo), 04 bank account changed, 05 more invoiced than received, 06 already paid, 07 a duplicate of 03. Check 0 of each PDF and photo says what Textract agreed on (e.g. "Textract agrees on invoice no., PO, total"). With the local model, 03 may also go to review if it misreads the UEN in the photo. That is the check doing its job.

### 7. Use your own suppliers and POs

Edit the three files in `data/` (copy the format of the sample entries):

| File | What goes in it |
|---|---|
| `suppliers.json` | Each supplier: id, name, UEN, GST reg. no. (or null), bank account (or a list, if it has several) |
| `purchase-orders.json` | Each PO: number, supplier id, currency, **site** (address with postal code) and **period** (`YYYY-MM`), lines. Goods line: description, unit price, ordered qty, **received qty**. Service line: description, ordered qty, and either **amount** (the monthly charge for that qty) or unit price; no received qty (the proof is the signed service record on the invoice) |
| `recorded-invoices.json` | Invoices already recorded or paid (for the duplicate check): supplier id, invoice number, and the **PO number** it billed (so a monthly service PO isn't paid twice) |

Then click **Re-check all** (the circular arrow). It reloads `data/` and runs every check again, with no AI and in about a second.

**Real example:** `examples/icfm/` holds Rentokil and Masandao with two example keyed POs (one by monthly amount, one by unit price). Run `DATA_DIR=examples/icfm npm run ui` and upload `~/Desktop/research/invoice-type/Rentokil 0021490975.pdf`.

### Without the page (command line)

```bash
npm run match -- path/to/folder
```

This matches every file in the folder and writes `output/results.json` and `output/summary.csv`.

### Tests

```bash
npm test
```

There are 126 tests. They need no AI, no AWS and no internet: Bedrock and Textract are replaced by stand-ins.

---

## Settings

All settings go in `.env`. With an AWS login, none are needed: the defaults are Bedrock + Textract in Singapore.

| Setting | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | `bedrock` | `bedrock` (Claude on Amazon Bedrock), `claude` (Claude API) or `local`: the default AI (the page can switch per run) |
| `BEDROCK_MODEL` | `anthropic.claude-sonnet-5` | Bedrock model. Claude Sonnet 5 runs **In-Region in Singapore**. `global.anthropic.claude-opus-5-5` is newer but "Global": invoices may leave Singapore |
| `BEDROCK_REGION` | `ap-southeast-1` | Bedrock region (not taken from `AWS_REGION`, on purpose) |
| `BEDROCK_EFFORT` | `medium` | How hard Claude thinks: `low`, `medium` or `high` |
| `BEDROCK_CONCURRENCY` | `8` | Invoices read on Bedrock at the same time (raise it if your Bedrock quota allows) |
| `TEXTRACT` | `on` | `on` = Amazon Textract reads every PDF page and photo first; its text goes to the AI and check 0 compares its fields. Used with Bedrock and the Claude API, never with the local LLM. Each file is read once while the app runs: retries and **Read again** reuse the result. `off` only for trying without AWS (`TEXTRACT_CROSS_CHECK` is the old name) |
| `TEXTRACT_REGION` | `ap-southeast-1` | Textract region (not taken from `AWS_REGION`, on purpose) |
| `TEXTRACT_TPS` | `1` | Textract requests per second your AWS quota allows (Singapore default: 1). Requests wait their turn |
| `TEXTRACT_MAX_PAGES` | `5` | Most PDF pages sent to Textract (one request per page). Later pages get a note in check 0; Claude still reads the whole PDF |
| `ANTHROPIC_API_KEY` | — | Only for `AI_PROVIDER=claude` |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` / `CLAUDE_CONCURRENCY` | `claude-opus-5-5` / `medium` / `8` | Only for `AI_PROVIDER=claude` |
| `LOCAL_LLM_BASE_URL` | `http://localhost:11434/v1` | Your local server. Ollama `:11434`, LM Studio `:1234`, vLLM `:8000`, llama.cpp `:8080` |
| `LOCAL_LLM_MODEL` | `gemma4:12b` | Must be a **vision** model to read photos and scans |
| `LOCAL_LLM_API` | `ollama` on port 11434, else `openai` | `ollama` = Ollama's own API (thinking off, fixed context, an error instead of silently cutting a long invoice). `openai` = the standard API for LM Studio, vLLM and llama.cpp |
| `LOCAL_LLM_NUM_CTX` | `16384` | Ollama's own API only: context size in tokens (for other servers, set it in the server) |
| `LOCAL_LLM_API_KEY` | (empty) | Only if your local server needs a key (vLLM, LM Studio) |
| `LOCAL_LLM_CONCURRENCY` | `1` | Invoices the local server reads at the same time (one GPU = 1) |
| `LOCAL_LLM_TIMEOUT_MS` | `300000` | Longest wait for one answer from the local server. A timeout counts as "busy" and is retried |
| `LOCAL_LLM_MAX_PDF_PAGES` | `5` | Scanned PDF pages turned into images. Extra pages are flagged, never skipped silently |
| `READ_MAX_ATTEMPTS` | `3` | Review page only: tries when Textract or the AI is busy, rate-limited, unreachable or timed out (pauses of 30 s, 60 s…), before the invoice goes to review. The command line doesn't retry |
| `BUYER_NAMES` | `Industrial & Commercial Facilities Management Pte Ltd` | Our company name(s), separated by a vertical bar (\|). Every invoice must be billed to one of them ("Mgm", "Mgt", "PL" short forms are fine) |
| `GST_RATE` | `0.09` | Singapore GST |
| `ROUNDING_TOLERANCE` | `1.00` | Differences up to this are "matched with a note", bigger ones go to review |
| `LINE_MATCH_MIN_SCORE` | `0.5` | How similar (0–1) an invoice line's description must be to a PO line to count as the same item |
| `PORT` | `3000` | Port of the review page |
| `DATA_DIR` / `UI_STORE_DIR` | `data` / `output/ui` | Where suppliers/POs are read from, and where the page keeps uploads and results |

## Troubleshooting

| You see | Do this |
|---|---|
| "No AWS login found" | Run `aws configure` (or `aws sso login`). Invoices try 3 times, then go to Review: use **Read again** after logging in |
| "…couldn't get the AWS login (network down, or the SSO session ended)" | It tries again by itself (30 s, then 60 s). If it keeps failing, run `aws sso login`, then **Read again** |
| "…rejected the AWS login (expired?)" | Your login ran out: run `aws sso login`, then **Read again** |
| "…may not use anthropic.claude-sonnet-5" | Give the login `bedrock:InvokeModel`, and check Claude Sonnet 5 in the Bedrock console (Singapore) |
| "…may not use textract:AnalyzeExpense" | Give the login that permission |
| "Bedrock … busy (quota reached)" or "Textract … busy" | Retried by itself (30 s, then 60 s). If it keeps happening, ask AWS to raise the quota (Textract: then raise `TEXTRACT_TPS`) |
| Check 0 note "Textract couldn't read all of it" | Textract couldn't read that page (or a broken PDF); the AI read it alone. Look at the file |
| "Not ready · Set ANTHROPIC_API_KEY" | Add the key to `.env`, then stop (Ctrl+C) and run `npm run ui` again |
| "Ollama isn't running" | Open the Ollama app, or run `ollama serve` |
| "Ollama has no gemma4:12b" | Run `ollama pull gemma4:12b` |
| "Text only: … can't read photos" | Choose a vision model, e.g. `qwen3.5:9b` or `gemma4:12b` |
| An invoice says "too long for the model's context" | Ollama: raise `LOCAL_LLM_NUM_CTX` (e.g. 32768). LM Studio / vLLM / llama.cpp: raise the context length in that server's settings |
| Local model is slow (minutes per invoice) | Upgrade Ollama, and keep `LOCAL_LLM_API=ollama` (it turns "thinking" off). On other servers, turn thinking off in the server |
| Many invoices take long | Textract allows 1 request/second by default: ask AWS to raise the AnalyzeExpense quota, then raise `TEXTRACT_TPS` |
| "Forbidden: open the page at http://localhost:3000" | Use exactly that address. The page refuses other addresses on purpose (security) |
| Port 3000 in use | `PORT=3001 npm run ui` |

## Measured on this Mac (Apple M5, 24 GB)

| What | Result |
|---|---|
| Local `gemma4:12b`, one invoice (PDF, photo, Excel, SVG) | **15–18 s each** with thinking off (86–171 s with thinking on) |
| 700 InvoiceNow XML uploaded at once | Accepted in 1.0 s, all checked in 2.1 s |
| 700 AI invoices at once (stand-in AI server, 8 at a time, 10% "busy" errors) | All 700 done in 44 s, never more than 8 at once, all 70 errors retried |
| Textract + Bedrock speed and cost per invoice | **Not measured yet** (needs a live AWS test) |
