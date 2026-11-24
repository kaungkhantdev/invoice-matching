# Invoice Matching (Singapore, 700 invoices/month)

> **Any format in → our standard invoice → check against the PO and the delivery → people only look at the problems.**
>
> **Textract reads. Bedrock understands. Rules decide.**
>
> **Start here:** [Setup & run](invoice-matching-service/README.md) · [System design](docs/SYSTEM-DESIGN.md) · [Infrastructure on AWS](docs/INFRASTRUCTURE-AWS.md)

## 4 steps: READ → MAP → MATCH → FLAG

### 1. READ: get the data out, whatever the format

| Supplier sends | How we read it | AI? |
|---|---|---|
| **InvoiceNow e-invoice (Peppol)** | Read the data fields directly. This is the most accurate. | No |
| Excel / CSV | Read the cells | No |
| PDF made on a computer, SVG, email, Word | Copy the text out, then find the fields | Getting the text out: no. Finding fields across many supplier layouts: yes |
| Scan, phone photo, screenshot | Read the image | Yes |

**InvoiceNow** is Singapore's national e-invoice network. IRAS is phasing it in for GST-registered businesses, so more suppliers will send invoices this way over time. Ask suppliers to use it.

### 2. MAP: fill in OUR standard invoice

- **Supplier:** name, UEN, GST registration no., bank account holder, account number, SWIFT (or PayNow UEN)
- **Header:** invoice #, invoice date, due date, **PO number**, **billed to**, **delivery site**, **month** it is for
- **Lines:** description, qty/hours, unit price, amount
- **Totals:** subtotal, GST, fees, discounts, total, **currency**
- **Proof attached:** service reports / cards / delivery orders: site, dates, signed, items not done
- **Original file:** always keep a link to it

Watch out for:
- **Dates:** Singapore writes DD/MM/YYYY, but our template shows MM/DD/YYYY. Is 03/04 the 3rd of April or the 4th of March? Pick one format (YYYY-MM-DD is the safest) and convert everything to it.
- **Currency:** SGD vs USD, MYR and others. It must be the same currency as the PO.
- **Prices before GST vs prices including GST**
- **Supplier product names** that don't match ours

### 3. MATCH: the 6 checks

1. **Math adds up:** qty × price = amount; subtotal + GST + fees − discounts = total; GST = 9% of the taxable amount
2. **PO exists** (found by the PO number, or by supplier + site + month), belongs to this supplier, same currency, **billed to us**, same **site** and **month**
3. **Lines match:** price = PO price; qty ≤ received (goods, 3-way match with the delivery note) or ≤ ordered plus a **signed service record** in that month (services)
4. **Total matches**, allowing a small rounding difference that we set (e.g. ±S$1)
5. **Not a duplicate:** have we seen this supplier + invoice # before, or was the same monthly service PO already billed?
6. **Supplier is real:** the bank account is the one on file, and if GST is charged, the GST registration no. is valid (we can look it up on the IRAS website)

### 4. FLAG: sort the result

- ✅ **Match** → approve for payment
- ⚠️ **Small difference** (within the rounding allowance) → approve with a note
- ❌ **Mismatch** (missing PO, wrong price or qty, duplicate, new bank account) → a person reviews it

## Built for 700 invoices a month

- 700 a month ≈ **35 per working day**. Plan for month-end peaks of about 3× a normal day.
- By hand, at 5 min each, that's about **58 hours a month** of typing. The goal is that most invoices pass with nobody touching them.

**6 rules so the system doesn't break:**

1. **One way in:** one invoice email address plus an upload page. Every file is saved with an ID before anything else happens, so nothing gets lost.
2. **Queue + retry:** invoices wait in line. If reading fails, the system tries again, then sends the invoice to a person. Nothing is ever dropped.
3. **Duplicate guard:** block the same file uploaded twice, or the same supplier + invoice #.
4. **Unsure = a person checks:** if the reader isn't sure about a field, or any check fails, the invoice goes to the review list. Never pay on a guess.
5. **Full record:** keep the original file, the data we read, the check results, and who approved it and when. IRAS requires business records to be kept for 5 years.
6. **Weekly numbers:** % matched automatically, how many are waiting for review, the oldest one waiting, and accuracy for each supplier.

**Data:** invoices can contain personal data (PDPA). Check where any cloud tool stores and processes it.

## Do we need AI?

At 700 a month from many suppliers with their own formats, setting up each supplier by hand doesn't keep up. **Use AI (or a ready-made invoice reader) only for the READ step.** MATCH and FLAG are always plain rules.

Ways to use less AI:
- Get suppliers to send through **InvoiceNow** (no AI needed)
- Give your **biggest suppliers** our Excel template
- A few suppliers usually send most of the invoices, so a fixed setup for just those few can be enough

## Tool options

| Option | Good for | Watch out |
|---|---|---|
| **InvoiceNow** through our accounting software or an access point | Suppliers already on InvoiceNow | Our accounting system must be able to receive InvoiceNow |
| Ready-made invoice readers: Azure Document Intelligence, Google Document AI, AWS Textract | English invoices; 700 a month is easy for them | We still need our own matching checks. Check where the data is processed. |
| Claude (vision) + our field list | Unusual layouts, mixed languages, messy photos | Needs a small script, and someone checking the results at first |
| AP automation software (e.g. Rossum, Nanonets) | The full workflow, with approvals and accounting links | Monthly cost and setup time |

## Suggested start

1. Turn on receiving InvoiceNow invoices in our accounting software.
2. For everything else: one inbox → reader (**Amazon Textract** for the text + **Claude on Amazon Bedrock** for the meaning, both in Singapore) → our standard fields → checks → review list.
3. **PO number on every invoice:** suppliers are asked to quote the PO our team keyed (from November 2026). Until then, invoices are matched by supplier + site + month, with a note.
4. **Pilot:** take about 50 real invoices from our top suppliers, in mixed formats. Measure how many fields come out right and what % match automatically before going live.
