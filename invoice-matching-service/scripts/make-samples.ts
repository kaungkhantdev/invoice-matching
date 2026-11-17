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
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { buildUbl } from "./ubl.js";

const OUT = "samples/invoices";
await mkdir(OUT, { recursive: true });
const file = (name: string) => join(OUT, name);

const ORCHID = { name: "Orchid Garden Supplies Pte. Ltd.", uen: "201912345K", street: "21 Lim Chu Kang Lane 3", postalZone: "718888" };
const ORCHID_BANK = { account: "0721234567", holder: "Orchid Garden Supplies Pte. Ltd.", swift: "DBSSSGSG" };

// 01 — InvoiceNow XML, all good
await writeFile(
  file("01-orchid-garden-INV-24051.xml"),
  buildUbl({
    id: "INV-24051",
    issueDate: "2026-11-03",
    dueDate: "2026-12-03",
    poNumber: "PO-2026-0101",
    supplier: ORCHID,
    bank: ORCHID_BANK,
    lines: [
      { name: "Red rose stems (box of 50)", qty: "10", price: "85.00" },
      { name: "Eucalyptus bunch", qty: "20", price: "12.00" },
      { name: "Baby's breath bunch", qty: "15", price: "9.50" },
    ],
  }),
);

// 06 — InvoiceNow XML, already recorded (duplicate)
await writeFile(
  file("06-kallang-packaging-KP-88120.xml"),
  buildUbl({
    id: "KP-88120",
    issueDate: "2026-10-28",
    dueDate: "2026-11-27",
    poNumber: "PO-2026-0102",
    supplier: { name: "Kallang Packaging Pte. Ltd.", uen: "201788888W", street: "12 Kallang Place #05-11", postalZone: "339155" },
    bank: { account: "501234567001", holder: "Kallang Packaging Pte. Ltd.", swift: "OCBCSGSG" },
    lines: [
      { name: "Kraft wrapping paper roll", qty: "30", price: "18.00" },
      { name: "Gift box medium", qty: "200", price: "2.40" },
    ],
  }),
);

// 02 — PDF in the supplier's own layout, wrong price
{
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = createWriteStream(file("02-kallang-packaging-KP-88131.pdf"));
  doc.pipe(stream);
  doc.font("Helvetica-Bold").fontSize(18).text("KALLANG PACKAGING PTE. LTD.", { align: "right" });
  doc.font("Helvetica").fontSize(9)
    .text("12 Kallang Place #05-11, Singapore 339155", { align: "right" })
    .text("UEN & GST Reg No: 201788888W", { align: "right" });
  doc.moveDown(2).font("Helvetica-Bold").fontSize(16).text("TAX INVOICE");
  doc.moveDown(0.5).font("Helvetica").fontSize(10)
    .text("Bill To: Petal Lane Florist Pte. Ltd., 8 Sample Road, Singapore 000000")
    .text("Invoice No.: KP-88131")
    .text("Invoice Date: 04/11/2026")
    .text("Terms: 30 days")
    .text("Customer PO: PO-2026-0102")
    .text("D/O No.: DO-55102");
  const cols = [50, 120, 330, 400, 480];
  const row = (y: number, cells: string[], bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
    cells.forEach((c, i) => doc.text(c, cols[i], y, { width: i === 1 ? 200 : 70, align: i >= 2 ? "right" : "left" }));
  };
  let y = 300;
  row(y, ["Item Code", "Description", "Qty", "U/Price", "Amount"], true);
  doc.moveTo(50, y + 15).lineTo(550, y + 15).stroke();
  row((y += 25), ["KP-KR01", "Kraft wrapping paper roll", "10", "18.00", "180.00"]);
  row((y += 20), ["KP-GB-M", "Gift Box (Medium)", "100", "2.60", "260.00"]);
  doc.moveTo(50, y + 20).lineTo(550, y + 20).stroke();
  row((y += 35), ["", "", "", "Sub Total", "440.00"]);
  row((y += 18), ["", "", "", "GST @ 9%", "39.60"]);
  row((y += 18), ["", "", "", "Grand Total (SGD)", "479.60"], true);
  doc.font("Helvetica").fontSize(9).text(
    "Please pay by bank transfer to OCBC Bank, A/C No. 501-234567-001, SWIFT OCBCSGSG, A/C Name: Kallang Packaging Pte. Ltd.",
    50,
    y + 60,
  );
  doc.end();
  await once(stream, "finish");
}

// 03 — phone photo of a small supplier's invoice book (no GST)
const ribbonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1150">
  <rect width="100%" height="100%" fill="#fbf8ef"/>
  <g font-family="Courier New, monospace" fill="#1d2a52">
    <text x="60" y="90" font-size="38" font-weight="bold">TIONG BAHRU RIBBON &amp; CRAFT</text>
    <text x="60" y="130" font-size="22">Blk 55 Tiong Bahru Road #01-23 Singapore 160055</text>
    <text x="60" y="165" font-size="22">UEN: 53312345A    (Not GST registered)</text>
    <text x="60" y="250" font-size="34" font-weight="bold">INVOICE</text>
    <text x="560" y="250" font-size="28">No. TBR-0457</text>
    <text x="60" y="300" font-size="24">Date: 06/11/2026</text>
    <text x="60" y="340" font-size="24">To: Petal Lane Florist</text>
    <text x="520" y="340" font-size="24">Your PO: PO-2026-0103</text>
    <line x1="60" y1="390" x2="840" y2="390" stroke="#1d2a52" stroke-width="2"/>
    <text x="60" y="425" font-size="24">Qty  Description               Unit $   Amount $</text>
    <line x1="60" y1="440" x2="840" y2="440" stroke="#1d2a52" stroke-width="1"/>
    <text x="60" y="485" font-size="24">40   Satin ribbon 25mm roll     6.50     260.00</text>
    <line x1="60" y1="560" x2="840" y2="560" stroke="#1d2a52" stroke-width="2"/>
    <text x="500" y="610" font-size="30" font-weight="bold">TOTAL S$ 260.00</text>
    <text x="60" y="720" font-size="22">Payment: UOB 351-301-234-5</text>
    <text x="60" y="755" font-size="22">A/C name: Tiong Bahru Ribbon &amp; Craft</text>
    <text x="60" y="850" font-size="26" font-style="italic">Thank you!</text>
  </g>
</svg>`;
const ribbonPng = await sharp(Buffer.from(ribbonSvg)).png().toBuffer();
await sharp(ribbonPng)
  .rotate(-3, { background: "#7d7468" })
  .blur(0.6)
  .modulate({ brightness: 0.93 })
  .jpeg({ quality: 78 })
  .toFile(file("03-tiong-bahru-ribbon-photo.jpg"));

// 07 — the same photo again, as an iPhone HEIC (macOS only)
try {
  execFileSync("sips", ["-s", "format", "heic", file("03-tiong-bahru-ribbon-photo.jpg"), "--out", file("07-tiong-bahru-ribbon-photo.heic")], {
    stdio: "ignore",
  });
} catch {
  console.log("Skipped 07 (HEIC): needs macOS 'sips'");
}

// 04 — Excel in the supplier's own layout, bank account changed
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Invoice");
  ws.getColumn(2).width = 32;
  ws.addRow(["JURONG COLD CHAIN LOGISTICS PTE. LTD."]);
  ws.addRow(["UEN / GST Reg: 202011111R"]);
  ws.addRow(["50 Jurong Port Road, Singapore 619110"]);
  ws.addRow([]);
  ws.addRow(["TAX INVOICE"]);
  ws.addRow(["Invoice No:", "JCC-1107"]);
  ws.addRow(["Date:", "05/11/2026"]);
  ws.addRow(["Your PO:", "PO-2026-0104"]);
  ws.addRow(["Customer:", "Petal Lane Florist Pte. Ltd."]);
  ws.addRow([]);
  ws.addRow(["S/N", "Service", "Trips", "Rate (S$)", "Line Total (S$)"]);
  ws.addRow([1, "Cold-chain delivery trip (Nov wk1-2)", 8, 120, 960]);
  ws.addRow([]);
  ws.addRow(["", "", "", "Sub-total", 960]);
  ws.addRow(["", "", "", "GST 9%", 86.4]);
  ws.addRow(["", "", "", "Total Payable", 1046.4]);
  ws.addRow([]);
  ws.addRow(["Bank:", "DBS Bank, A/C 072-999888-1, SWIFT DBSSSGSG (new account, please update)"]);
  for (const r of [14, 15, 16]) ws.getRow(r).getCell(5).numFmt = "#,##0.00";
  await wb.xlsx.writeFile(file("04-jurong-cold-chain-JCC-1107.xlsx"));
}

// 05 — SVG invoice, more invoiced than received
await writeFile(
  file("05-orchid-garden-INV-24063.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g font-family="Helvetica, Arial, sans-serif" fill="#222">
    <rect x="0" y="0" width="800" height="110" fill="#2e6b3f"/>
    <text x="40" y="60" font-size="30" font-weight="bold" fill="#fff">Orchid Garden Supplies Pte. Ltd.</text>
    <text x="40" y="90" font-size="15" fill="#e6f2e9">21 Lim Chu Kang Lane 3, Singapore 718888 · UEN/GST Reg No. 201912345K</text>
    <text x="40" y="170" font-size="26" font-weight="bold">TAX INVOICE  INV-24063</text>
    <text x="40" y="210" font-size="16">Date: 10/11/2026</text>
    <text x="40" y="235" font-size="16">Due: 10/12/2026</text>
    <text x="420" y="210" font-size="16">Bill to: Petal Lane Florist Pte. Ltd.</text>
    <text x="420" y="235" font-size="16">PO Ref: PO-2026-0105</text>
    <rect x="40" y="280" width="720" height="34" fill="#eef5ef"/>
    <text x="50" y="303" font-size="15" font-weight="bold">Description</text>
    <text x="430" y="303" font-size="15" font-weight="bold">Qty</text>
    <text x="520" y="303" font-size="15" font-weight="bold">Unit Price</text>
    <text x="650" y="303" font-size="15" font-weight="bold">Amount</text>
    <text x="50" y="345" font-size="15">White lily stems (box)</text>
    <text x="430" y="345" font-size="15">6</text>
    <text x="520" y="345" font-size="15">64.00</text>
    <text x="650" y="345" font-size="15">384.00</text>
    <line x1="40" y1="370" x2="760" y2="370" stroke="#999"/>
    <text x="520" y="410" font-size="15">Subtotal</text><text x="650" y="410" font-size="15">384.00</text>
    <text x="520" y="435" font-size="15">GST 9%</text><text x="650" y="435" font-size="15">34.56</text>
    <text x="520" y="470" font-size="18" font-weight="bold">Total SGD</text><text x="650" y="470" font-size="18" font-weight="bold">418.56</text>
    <text x="40" y="560" font-size="14">Bank: DBS 072-123456-7 · SWIFT DBSSSGSG · A/C: Orchid Garden Supplies Pte. Ltd.</text>
  </g>
</svg>
`,
);

console.log(`Sample invoices written to ${OUT}/`);
