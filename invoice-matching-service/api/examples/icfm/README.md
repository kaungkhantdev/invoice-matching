# Example: real ICFM suppliers + keyed POs

Two real suppliers (from their invoices) and two **example** POs, as our team would key them:

| PO | Supplier | Site | Month | Lines |
|---|---|---|---|---|
| PO-EXAMPLE-2CSS2-2026-10 | Rentokil | 2 Changi South Street 2 | 2026-10 | monthly amount per item |
| PO-EXAMPLE-SIGLAP-2026-08 | Masandao | 55 Siglap Centre | 2026-08 | unit price per item |

For `npm run match` (a folder of invoices without PO screenshots; the page always uses the PO uploaded with the invoice). In `api/`:

```bash
DATA_DIR=examples/icfm npm run match -- path/to/folder
```

How to key a PO so invoices match:
- `site`: the address (street + postal code), not a short code like "2CSS2".
- `period`: the month, `YYYY-MM`.
- Service lines: `orderedQty` and either `amount` (the monthly charge for that quantity, shared pro rata) or `unitPrice` (per item), and **no** `receivedQty`: the proof is the signed service record attached to the invoice.
- Goods lines: `unitPrice`, `orderedQty` and `receivedQty` (from the delivery).
- A PO with service lines is billed **once**: a second invoice for it goes to Review. Record paid invoices in `recorded-invoices.json` with their `poNumber` so this works across months too.
- To try it, put `~/Desktop/research/invoice-type/Rentokil 0021490975.pdf` (October, 2 Changi South Street 2) in a folder and match that folder.
