/**
 * The sample invoices in a supplier's own layout (PDF, phone photo, Excel, SVG): the ones the AI has to read.
 * make-samples.ts lists what each one should get from the checks.
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import sharp from "sharp";

/** The PDF's item table: Item Code, Description, Qty, U/Price, Amount. */
const PDF_COLUMNS = [
  { x: 50, width: 70, align: "left" },
  { x: 120, width: 200, align: "left" },
  { x: 330, width: 70, align: "right" },
  { x: 400, width: 70, align: "right" },
  { x: 480, width: 70, align: "right" },
] as const;

/** 02: Kallang Packaging's PDF tax invoice. The gift box is 2.60; the PO says 2.40. */
export async function writeKallangPdf(path: string): Promise<void> {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = createWriteStream(path);
  doc.pipe(stream);
  doc.font("Helvetica-Bold").fontSize(18).text("KALLANG PACKAGING PTE. LTD.", { align: "right" });
  doc.font("Helvetica").fontSize(9)
    .text("12 Kallang Place #05-11, Singapore 339155", { align: "right" })
    .text("UEN & GST Reg No: 201788888W", { align: "right" });
  doc.moveDown(2).font("Helvetica-Bold").fontSize(16).text("TAX INVOICE");
  doc.moveDown(0.5).font("Helvetica").fontSize(10)
    .text("Bill To: Industrial & Commercial Facilities Management Pte Ltd, 202 Kallang Bahru #08-09A, Singapore 339339")
    .text("Invoice No.: KP-88131")
    .text("Invoice Date: 04/11/2026")
    .text("Terms: 30 days")
    .text("Customer PO: PO-2026-0102")
    .text("D/O No.: DO-55102");
  drawKallangItems(doc);
  doc.font("Helvetica").fontSize(9).text(
    "Please pay by bank transfer to OCBC Bank, A/C No. 501-234567-001, SWIFT OCBCSGSG, " +
      "A/C Name: Kallang Packaging Pte. Ltd.",
    50,
    476,
  );
  doc.end();
  await once(stream, "finish");
}

/** The PDF's item table and totals. y is in points from the top of the page. */
function drawKallangItems(doc: PDFKit.PDFDocument): void {
  const row = (y: number, cells: string[], bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
    cells.forEach((cell, i) => {
      const column = PDF_COLUMNS[i];
      doc.text(cell, column.x, y, { width: column.width, align: column.align });
    });
  };
  const rule = (y: number) => doc.moveTo(50, y).lineTo(550, y).stroke();

  row(300, ["Item Code", "Description", "Qty", "U/Price", "Amount"], true);
  rule(315);
  row(325, ["KP-KR01", "Kraft wrapping paper roll", "10", "18.00", "180.00"]);
  row(345, ["KP-GB-M", "Gift Box (Medium)", "100", "2.60", "260.00"]);
  rule(365);
  row(380, ["", "", "", "Sub Total", "440.00"]);
  row(398, ["", "", "", "GST @ 9%", "39.60"]);
  row(416, ["", "", "", "Grand Total (SGD)", "479.60"], true);
}

/** 03: a phone photo of a small supplier's invoice book (no GST): the page, tilted, slightly blurred and darker. */
export async function writeRibbonPhoto(path: string): Promise<void> {
  const page = await sharp(Buffer.from(RIBBON_INVOICE_SVG)).png().toBuffer();
  await sharp(page)
    .rotate(-3, { background: "#7d7468" })
    .blur(0.6)
    .modulate({ brightness: 0.93 })
    .jpeg({ quality: 78 })
    .toFile(path);
}

/** 07: the same photo again, as an iPhone HEIC. Needs macOS's `sips`; skipped elsewhere. */
export function writeHeicCopy(jpgPath: string, heicPath: string): void {
  try {
    execFileSync("sips", ["-s", "format", "heic", jpgPath, "--out", heicPath], { stdio: "ignore" });
  } catch {
    console.log("Skipped 07 (HEIC): needs macOS 'sips'");
  }
}

/** 04: Jurong Cold Chain's Excel invoice. The bank account is not the one on file. */
export async function writeJurongExcel(path: string): Promise<void> {
  const rows: (string | number)[][] = [
    ["JURONG COLD CHAIN LOGISTICS PTE. LTD."],
    ["UEN / GST Reg: 202011111R"],
    ["50 Jurong Port Road, Singapore 619110"],
    [],
    ["TAX INVOICE"],
    ["Invoice No:", "JCC-1107"],
    ["Date:", "05/11/2026"],
    ["Your PO:", "PO-2026-0104"],
    ["Customer:", "Industrial & Commercial Facilities Management Pte Ltd"],
    [],
    ["S/N", "Service", "Trips", "Rate (S$)", "Line Total (S$)"],
    [1, "Cold-chain delivery trip (Nov wk1-2)", 8, 120, 960],
    [],
    ["", "", "", "Sub-total", 960],
    ["", "", "", "GST 9%", 86.4],
    ["", "", "", "Total Payable", 1046.4],
    [],
    ["Bank:", "DBS Bank, A/C 072-999888-1, SWIFT DBSSSGSG (new account, please update)"],
  ];
  // Sub-total, GST and Total Payable (rows 14–16, column E) show cents: 1046.4 → 1,046.40.
  const totalRows = [14, 15, 16];
  const amountColumn = 5;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Invoice");
  sheet.getColumn(2).width = 32;
  for (const row of rows) sheet.addRow(row);
  for (const row of totalRows) sheet.getRow(row).getCell(amountColumn).numFmt = "#,##0.00";
  await workbook.xlsx.writeFile(path);
}

/** 05: Orchid Garden's SVG tax invoice. 6 boxes are invoiced; only 4 were received. */
export async function writeOrchidSvg(path: string): Promise<void> {
  await writeFile(path, ORCHID_SVG_INVOICE);
}

/** The page of the ribbon shop's invoice book, before it is "photographed" (03, 07). */
const RIBBON_INVOICE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1150">
  <rect width="100%" height="100%" fill="#fbf8ef"/>
  <g font-family="Courier New, monospace" fill="#1d2a52">
    <text x="60" y="90" font-size="38" font-weight="bold">TIONG BAHRU RIBBON &amp; CRAFT</text>
    <text x="60" y="130" font-size="22">Blk 55 Tiong Bahru Road #01-23 Singapore 160055</text>
    <text x="60" y="165" font-size="22">UEN: 53312345A    (Not GST registered)</text>
    <text x="60" y="250" font-size="34" font-weight="bold">INVOICE</text>
    <text x="560" y="250" font-size="28">No. TBR-0457</text>
    <text x="60" y="300" font-size="24">Date: 06/11/2026</text>
    <text x="520" y="300" font-size="24">Your PO: PO-2026-0103</text>
    <text x="60" y="340" font-size="22">To: Industrial &amp; Commercial Facilities Mgm Pte Ltd</text>
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

/** Orchid Garden's invoice as an SVG file (05). */
const ORCHID_SVG_INVOICE = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g font-family="Helvetica, Arial, sans-serif" fill="#222">
    <rect x="0" y="0" width="800" height="110" fill="#2e6b3f"/>
    <text x="40" y="60" font-size="30" font-weight="bold" fill="#fff">Orchid Garden Supplies Pte. Ltd.</text>
    <text x="40" y="90" font-size="15" fill="#e6f2e9">21 Lim Chu Kang Lane 3, Singapore 718888 · UEN/GST Reg No. 201912345K</text>
    <text x="40" y="170" font-size="26" font-weight="bold">TAX INVOICE  INV-24063</text>
    <text x="40" y="210" font-size="16">Date: 10/11/2026</text>
    <text x="40" y="235" font-size="16">Due: 10/12/2026</text>
    <text x="420" y="210" font-size="16">Bill to: Industrial &amp; Commercial Facilities Mgt PL</text>
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
`;
