# Invoice Matching Service

Reads supplier invoices in any format (PDF, photo, iPhone HEIC, SVG, Excel, CSV, InvoiceNow XML), turns each one into **our standard invoice**, checks it against the PO and the delivery, and sorts it: **Matched** · **Matched with a note** · **Review** (a person looks).

> **AI reads. Rules decide.** The AI only copies what's on the invoice. Every pass/fail is plain, explainable code.

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

### 3. Choose the AI that reads PDFs and photos

XML (InvoiceNow) invoices need no AI. For everything else, pick one option. You can also switch per run in the page later.

**Option A: Claude (best accuracy; invoices are sent to Anthropic)**

Open `.env` and set:

```
AI_PROVIDER=claude
ANTHROPIC_API_KEY=your-key
```

**Option B: Local model with Ollama (free per invoice; invoices stay on this machine)**

1. Install or upgrade Ollama from ollama.com/download. Use **version 0.34.1 or newer**: older versions read small print in photos poorly. Check with:
   ```bash
   ollama --version
   ```
2. Download a vision model (about 8 GB):
   ```bash
   ollama pull gemma4:12b
   ```
3. Make sure the Ollama app is running (llama icon in the menu bar).
4. Open `.env` and set:
   ```
   AI_PROVIDER=local
   ```

The other defaults work for Ollama on this Mac. To use LM Studio, vLLM or llama.cpp instead, see [Settings](#settings).

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

1. Next to **Read with**, choose Claude or Local LLM. The dot turns green when it's ready.
2. Click the **document icon** at the top right to run the 7 sample invoices. Or press **+**, or drag files onto the page, to upload your own.
3. Click any invoice to see:
   - the 7 checks and why each one passed or failed
   - invoiced vs received for each line
   - what was read, compared with your records
   - the original file (eye icon)
4. **Approve** or **Reject** it. **Read again** reads the same file with the AI you pick (not for XML). The new result replaces the old one and clears any Approve/Reject, so note the first result if you want to compare.

What the 7 samples should show: 01 matched, 02 price too high, 03 matched (photo), 04 bank account changed, 05 more invoiced than received, 06 already paid, 07 a duplicate of 03. With the local model, 03 may also go to review if it misreads the UEN in the photo. That is the check doing its job.

### 7. Use your own suppliers and POs

Edit the three files in `data/` (copy the format of the sample entries):

| File | What goes in it |
|---|---|
| `suppliers.json` | Each supplier: id, name, UEN, GST reg. no. (or null), bank account |
| `purchase-orders.json` | Each PO: number, supplier id, currency, lines (description, unit price, ordered qty, **received qty**) |
| `recorded-invoices.json` | Invoices already recorded or paid (for the duplicate check) |

Then click **Re-check all** (the circular arrow). It reloads `data/` and runs every check again, with no AI and in about a second.

### Without the page (command line)

```bash
npm run match -- path/to/folder
```

This matches every file in the folder and writes `output/results.json` and `output/summary.csv`.

### Tests

```bash
npm test
```

There are 42 tests. They need no AI and no internet.

---

## Settings

All settings go in `.env`. Only `AI_PROVIDER` and its key or model are usually needed.

| Setting | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | `claude` | `claude` or `local`: the default AI (the page can switch per run) |
| `ANTHROPIC_API_KEY` | — | Needed for Claude |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model |
| `CLAUDE_EFFORT` | `medium` | How hard Claude thinks: `low`, `medium` or `high` |
| `CLAUDE_CONCURRENCY` | `8` | Invoices Claude reads at the same time (raise it if your API rate limit allows) |
| `LOCAL_LLM_BASE_URL` | `http://localhost:11434/v1` | Your local server. Ollama `:11434`, LM Studio `:1234`, vLLM `:8000`, llama.cpp `:8080` |
| `LOCAL_LLM_MODEL` | `gemma4:12b` | Must be a **vision** model to read photos and scans |
| `LOCAL_LLM_API` | `ollama` on port 11434, else `openai` | `ollama` = Ollama's own API (thinking off, fixed context, an error instead of silently cutting a long invoice). `openai` = the standard API for LM Studio, vLLM and llama.cpp |
| `LOCAL_LLM_NUM_CTX` | `16384` | Ollama's own API only: context size in tokens (for other servers, set it in the server) |
| `LOCAL_LLM_API_KEY` | (empty) | Only if your local server needs a key (vLLM, LM Studio) |
| `LOCAL_LLM_CONCURRENCY` | `1` | Invoices the local server reads at the same time (one GPU = 1) |
| `LOCAL_LLM_TIMEOUT_MS` | `300000` | Longest wait for one answer from the local server. A timeout counts as "busy" and is retried |
| `LOCAL_LLM_MAX_PDF_PAGES` | `5` | Scanned PDF pages turned into images. Extra pages are flagged, never skipped silently |
| `READ_MAX_ATTEMPTS` | `3` | Review page only: tries when the AI is busy, rate-limited, unreachable or timed out (pauses of 30 s, 60 s…), before the invoice goes to review. The command line doesn't retry |
| `GST_RATE` | `0.09` | Singapore GST |
| `ROUNDING_TOLERANCE` | `1.00` | Differences up to this are "matched with a note", bigger ones go to review |
| `LINE_MATCH_MIN_SCORE` | `0.5` | How similar (0–1) an invoice line's description must be to a PO line to count as the same item |
| `PORT` | `3000` | Port of the review page |
| `DATA_DIR` / `UI_STORE_DIR` | `data` / `output/ui` | Where suppliers/POs are read from, and where the page keeps uploads and results |

## Troubleshooting

| You see | Do this |
|---|---|
| "Not ready · Set ANTHROPIC_API_KEY" | Add the key to `.env`, then stop (Ctrl+C) and run `npm run ui` again |
| "Ollama isn't running" | Open the Ollama app, or run `ollama serve` |
| "Ollama has no gemma4:12b" | Run `ollama pull gemma4:12b` |
| "Text only: … can't read photos" | Choose a vision model, e.g. `qwen3.5:9b` or `gemma4:12b` |
| An invoice says "too long for the model's context" | Ollama: raise `LOCAL_LLM_NUM_CTX` (e.g. 32768). LM Studio / vLLM / llama.cpp: raise the context length in that server's settings |
| Local model is slow (minutes per invoice) | Upgrade Ollama, and keep `LOCAL_LLM_API=ollama` (it turns "thinking" off). On other servers, turn thinking off in the server |
| "Forbidden: open the page at http://localhost:3000" | Use exactly that address. The page refuses other addresses on purpose (security) |
| Port 3000 in use | `PORT=3001 npm run ui` |

## Measured on this Mac (Apple M5, 24 GB)

| What | Result |
|---|---|
| Local `gemma4:12b`, one invoice (PDF, photo, Excel, SVG) | **15–18 s each** with thinking off (86–171 s with thinking on) |
| 700 InvoiceNow XML uploaded at once | Accepted in 1.0 s, all checked in 2.1 s |
| 700 AI invoices at once (stand-in AI server, 8 at a time, 10% "busy" errors) | All 700 done in 44 s, never more than 8 at once, all 70 errors retried |
| Claude speed and cost per invoice | **Not measured yet** (needs an API key) |
