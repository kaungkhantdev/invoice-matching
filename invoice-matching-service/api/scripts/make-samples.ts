/**
 * Creates fake supplier invoices in different formats to try the system with.
 * Run: npm run samples   → files go to samples/invoices/
 *
 * Expected results (against the data in /data):
 *   01 XML   InvoiceNow, everything matches              → ✅
 *   02 PDF   gift box price 2.60, PO says 2.40           → ❌ price
 *   03 JPG   phone photo, small supplier, no GST          → ✅
 *   04 XLSX  bank account is not the one on file          → ❌ fraud check
 *   05 SVG   6 boxes invoiced, only 4 received            → ❌ quantity
 *   06 XML   invoice already recorded                     → ❌ duplicate
 *   07 HEIC  same photo as 03, sent again from an iPhone   → ❌ duplicate
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeHeicCopy,
  writeJurongExcel,
  writeKallangPdf,
  writeOrchidSvg,
  writeRibbonPhoto,
} from "./supplier-layouts.js";
import { buildUbl } from "./ubl.js";

const OUT = "samples/invoices";
const file = (name: string) => join(OUT, name);

await mkdir(OUT, { recursive: true });
await writeFile(file("01-orchid-garden-INV-24051.xml"), orchidGardenXml());
await writeFile(file("06-kallang-packaging-KP-88120.xml"), kallangPackagingXml());
await writeKallangPdf(file("02-kallang-packaging-KP-88131.pdf"));
await writeRibbonPhoto(file("03-tiong-bahru-ribbon-photo.jpg"));
writeHeicCopy(file("03-tiong-bahru-ribbon-photo.jpg"), file("07-tiong-bahru-ribbon-photo.heic"));
await writeJurongExcel(file("04-jurong-cold-chain-JCC-1107.xlsx"));
await writeOrchidSvg(file("05-orchid-garden-INV-24063.svg"));
console.log(`Sample invoices written to ${OUT}/`);

/** 01: InvoiceNow XML, all good. */
function orchidGardenXml(): string {
  return buildUbl({
    id: "INV-24051",
    issueDate: "2026-11-03",
    dueDate: "2026-12-03",
    poNumber: "PO-2026-0101",
    supplier: {
      name: "Orchid Garden Supplies Pte. Ltd.",
      uen: "201912345K",
      street: "21 Lim Chu Kang Lane 3",
      postalZone: "718888",
    },
    bank: { account: "0721234567", holder: "Orchid Garden Supplies Pte. Ltd.", swift: "DBSSSGSG" },
    lines: [
      { name: "Red rose stems (box of 50)", qty: "10", price: "85.00" },
      { name: "Eucalyptus bunch", qty: "20", price: "12.00" },
      { name: "Baby's breath bunch", qty: "15", price: "9.50" },
    ],
  });
}

/** 06: InvoiceNow XML for an invoice that is already recorded (a duplicate). */
function kallangPackagingXml(): string {
  return buildUbl({
    id: "KP-88120",
    issueDate: "2026-10-28",
    dueDate: "2026-11-27",
    poNumber: "PO-2026-0102",
    supplier: {
      name: "Kallang Packaging Pte. Ltd.",
      uen: "201788888W",
      street: "12 Kallang Place #05-11",
      postalZone: "339155",
    },
    bank: { account: "501234567001", holder: "Kallang Packaging Pte. Ltd.", swift: "OCBCSGSG" },
    lines: [
      { name: "Kraft wrapping paper roll", qty: "30", price: "18.00" },
      { name: "Gift box medium", qty: "200", price: "2.40" },
    ],
  });
}
