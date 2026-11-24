# System Design: Invoice Matching

> **Any invoice in → one standard invoice → 7 checks → people only see the problems.**
>
> **Textract reads. Bedrock understands. Rules decide.**

![System design: IN → QUEUE → READ → CHECK → REVIEW](images/system-design.png)

## 5 steps: IN → QUEUE → READ → CHECK → REVIEW

```
 Upload · Email · InvoiceNow
          │
   1  IN       save the file, add a row                  instant, even 700 at once
          │
   2  QUEUE    wait your turn · N read at a time          busy? wait, try again (3 tries in all)
          │
   3  READ     XML ────────────── read directly (no AI)
               PDF/photo/scan ─── ① Textract reads the text (OCR)
                                  ② Claude on Bedrock: file + that text
               Excel/CSV ──────── Claude on Bedrock reads the cells
                                  → OUR STANDARD INVOICE
          │
   4  CHECK    7 checks  ◄── supplier list · PO · delivery · recorded invoices
          │
   5  REVIEW   ✅ Matched → pay      ⚠️ Note → pay, see note      ❌ Review → a person decides
```

| Step | Job | In the code |
|---|---|---|
| 1 IN | Save the file and its row first, so nothing is lost | `InvoicesController`, `InvoiceStore.add` |
| 2 QUEUE | Let 700 arrive at once, but read only as many as the AI can handle | `InvoiceStore` (on AWS: SQS) |
| 3 READ | Turn any format into the same standard invoice | `ReaderService`, `TextractReader`, `BedrockExtractor` |
| 4 CHECK | Plain-code rules, each with a written reason | `CheckerService` |
| 5 REVIEW | Every invoice is listed with its result; people check the problems and approve or reject | review page (`public/`) |

## The 7 checks

| # | Check | Fails when |
|---|---|---|
| 0 | Read clearly | not an invoice, AI unsure of a field, a page not read, **Textract and Claude disagree**, or **several invoices in one file** |
| 1 | Math adds up | qty × price, subtotal, GST 9% or total don't add up |
| 2 | PO exists | not **billed to ICFM**, no keyed PO, wrong supplier, currency, **site or month** |
| 3 | Lines match PO | price ≠ PO, more than **received** (goods) or ordered, or no **signed service record** in the month (services) |
| 4 | Total matches PO | subtotal before GST ≠ the PO's amounts, or **extra fees** not on the PO |
| 5 | Not a duplicate | already recorded in accounting, the same invoice sent twice, or **the same monthly PO billed again** |
| 6 | Supplier is real | **bank account changed**, UEN or GST number differs |

Any ✗ → **Review**. A difference of ≤ 1.00 on any checked amount (rounding), or no GST from a GST-registered supplier → **Matched with a note**.

## Matching to the PO our team keyed

| Invoice has | Found by | Result |
|---|---|---|
| A PO number | the PO number | normal checks |
| No PO number | supplier + site + month (one keyed PO fits) | ⚠️ note: "ask the supplier to quote the PO number" |
| No PO number, no PO fits | – | ❌ Review, listing the supplier's POs for that month |

Suppliers are asked to quote the PO number from November 2026. Until then, site + month bridges the gap.

- **Site:** the invoice's site, or the address on its signed service card (Masandao prints only "ICFM-Siglap Centre"). Postal code decides; without one, the house and street numbers must all agree ("2 Changi South St 2" = "2 Changi South Street 2", ≠ "8 Changi South Street 2").
- **Month:** as printed ("Service for October 2026"); else the month of the signed service records (billed in arrears); else the invoice date.
- **Monthly amount:** the PO line's amount is for its quantity; fewer units are allowed pro rata (6 bins 21.60 → 4 bins 14.40).

**Services** (hygiene, cleaning…): the PO line holds the monthly amount (or a unit price) and no received quantity; the **proof is the signed service report or card attached to the invoice**: same site, same month, signed. Items it says weren't done ("No Stock") get a note. A service PO is **billed once**. **Goods**: unit price and received quantity, as before. Free lines (0.00, e.g. loaned dispensers) don't need to be on the PO.

What the reader catches, as marked by the team: supplier · bill to ICFM · invoice month · delivery site · items · prices · total before GST · service address, month and signature.

## 5 rules that never change

1. **AI reads, rules decide.** Textract and Claude only copy. Code decides pass or fail.
2. **Save first, read later.** Every invoice (file + row) is stored before any AI touches it.
3. **Nothing silent.** Unsure, unread or cut off → Review, never "matched".
4. **Money is exact.** Decimals only, never floating-point numbers.
5. **The later copy is the duplicate.** An identical file is flagged at once. A copy in another format (e.g. PDF + XML) is flagged once both are read.

## Textract + Bedrock: who does what

| | **Amazon Textract** | **Claude on Amazon Bedrock** |
|---|---|---|
| Job | Reads the **characters** (OCR) | Understands the **invoice**: which number is the total, which ID is the PO, the lines |
| Gets | Each PDF page or photo as an image | The file **and** Textract's text |
| Gives | Text + its own invoice fields | Our standard invoice |
| Where | Singapore | Singapore (Claude Sonnet 5, In-Region) |

**Why both:** Textract is exact on characters. Claude is good at meaning and at layouts it has never seen. Textract's own fields then double-check Claude's numbers in check 0:

| Compared | Rule |
|---|---|
| Invoice no., PO, GST reg. no. | Must be the same. A GST no. matching the UEN also counts |
| Subtotal, GST, total | Must be the same amount. Any printed form of the subtotal counts (before/after discount, with/without GST) |
| "Amount due" (when no total is printed) | A difference is only a **note**, since a deposit or balance brought forward is normal |
| A field only one of them found | Not compared |

| If Textract… | Then |
|---|---|
| disagrees with Claude | **Review** |
| is busy or unreachable | Wait and try again (like the AI) |
| can't read a page | Claude reads that page alone, with a **note** |
| can't get an AWS login | Try again (it may only be offline), then **Review** with the fix in plain words |

Each file goes to Textract **once** while the app runs: a queue retry or **Read again** reuses the result, so pages aren't paid for twice.

**Trying without AWS:** `AI_PROVIDER=claude` (Claude API, with `TEXTRACT=off`) or `local` (a model on your own machine, 15–18 s per invoice on a Mac M5; Textract is never used with it, so nothing leaves the machine). Same standard invoice, so steps 4 and 5 never change.

## Why 700 at once works

- **Arriving is cheap:** saving and queuing 700 files takes about a second.
- **Reading is the only slow part, and it's capped:** at most N at a time on Bedrock, and Textract at its requests per second. The rest wait safely.
- **Checks are instant:** milliseconds each, and can be re-run any time without AI.

> **Time for 700 = 700 × seconds per invoice ÷ invoices read at the same time**

Proven on this Mac:
- **XML:** 700 in one upload were checked in **2 seconds**.
- **AI queue:** 700 went through with **8 at a time**. All 70 "busy" errors were retried, and all 700 finished.

How this runs on AWS: [INFRASTRUCTURE-AWS.md](INFRASTRUCTURE-AWS.md).
