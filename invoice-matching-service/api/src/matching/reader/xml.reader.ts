import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { XMLParser } from "fast-xml-parser";
import { MONTH_LENGTH, type StandardInvoice } from "../invoice.schema.js";

/** A parsed XML element. The parser gives untyped objects, and UBL has too many elements to type them all. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

/** Elements that can appear more than once: always parsed as arrays, so one and several read the same way. */
const REPEATABLE = [
  "InvoiceLine",
  "CreditNoteLine",
  "TaxTotal",
  "PartyTaxScheme",
  "PaymentMeans",
  "Delivery",
  "InvoicePeriod",
];

/**
 * Reads InvoiceNow (Peppol UBL) e-invoices directly. No AI: every field has a fixed place.
 */
@Injectable()
export class XmlReader {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false, // keep amounts as strings
    parseAttributeValue: false,
    isArray: (name) => REPEATABLE.includes(name),
  });

  /** One InvoiceNow XML file → our standard invoice. Throws when it isn't a UBL invoice or credit note. */
  parse(xml: string): StandardInvoice {
    const parsed = this.parser.parse(xml);
    const isCreditNote = parsed.CreditNote != null;
    const root: Node = parsed.Invoice ?? parsed.CreditNote;
    if (!root) throw new Error("Not an InvoiceNow / UBL invoice (no <Invoice> or <CreditNote> root)");

    const currency = textOf(root.DocumentCurrencyCode) ?? "";
    const customer: Node = root.AccountingCustomerParty?.Party ?? {};
    const deliveryAddress: Node = (root.Delivery ?? [])[0]?.DeliveryLocation?.Address;
    const period: Node = (root.InvoicePeriod ?? [])[0];
    const totals: Node = root.LegalMonetaryTotal ?? {};
    const lines: Node[] = root.InvoiceLine ?? root.CreditNoteLine ?? [];

    return {
      documentType: isCreditNote ? "credit_note" : "tax_invoice",
      supplier: supplier(root.AccountingSupplierParty?.Party ?? {}),
      bank: bank((root.PaymentMeans ?? [])[0]?.PayeeFinancialAccount),
      billTo: textOf(customer.PartyLegalEntity?.RegistrationName) ?? textOf(customer.PartyName?.Name),
      site: deliveryAddress ? addressLine(deliveryAddress) : null,
      // Peppol allows a period with only a start or only an end date. "2026-10-01" → "2026-10".
      servicePeriod: (textOf(period?.StartDate) ?? textOf(period?.EndDate))?.slice(0, MONTH_LENGTH) ?? null,
      serviceRecords: [],
      otherInvoicesInFile: [],
      invoiceNumber: textOf(root.ID) ?? "",
      invoiceDate: textOf(root.IssueDate),
      dueDate: textOf(root.DueDate),
      poNumber: textOf(root.OrderReference?.ID),
      currency,
      pricesIncludeTax: false,
      lines: lines.map(invoiceLine),
      subtotal: textOf(totals.LineExtensionAmount) ?? "0",
      tax: textOf(taxTotal(root, currency)?.TaxAmount) ?? "0",
      fees: textOf(totals.ChargeTotalAmount) ?? "0",
      discounts: textOf(totals.AllowanceTotalAmount) ?? "0",
      total: textOf(totals.TaxInclusiveAmount) ?? textOf(totals.PayableAmount) ?? "0",
      uncertainFields: prepaidNote(totals),
    };
  }
}

/** Text of an element, whether or not it has attributes (e.g. <TaxAmount currencyID="SGD">). */
function textOf(node: Node): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node;
  if (typeof node === "object" && "#text" in node) return String(node["#text"]);
  return null;
}

function supplier(party: Node): StandardInvoice["supplier"] {
  const gstScheme: Node = (party.PartyTaxScheme ?? [])[0];
  return {
    name: textOf(party.PartyLegalEntity?.RegistrationName) ?? textOf(party.PartyName?.Name) ?? "",
    uen: textOf(party.PartyLegalEntity?.CompanyID),
    gstRegNo: textOf(gstScheme?.CompanyID),
    address: addressLine(party.PostalAddress ?? {}),
  };
}

function bank(account: Node): StandardInvoice["bank"] {
  return {
    accountHolder: textOf(account?.Name),
    accountNumber: textOf(account?.ID),
    swift: textOf(account?.FinancialInstitutionBranch?.ID),
  };
}

/** "2 Changi South Street 2, Singapore, 486759": the parts that are filled in, or null when none is. */
function addressLine(address: Node): string | null {
  const parts = [address.StreetName, address.AdditionalStreetName, address.CityName, address.PostalZone];
  return parts.map(textOf).filter(Boolean).join(", ") || null;
}

function invoiceLine(line: Node): StandardInvoice["lines"][number] {
  return {
    description: textOf(line.Item?.Name) ?? textOf(line.Item?.Description) ?? "",
    quantity: textOf(line.InvoicedQuantity ?? line.CreditedQuantity) ?? "0",
    // Peppol prices can be per BaseQuantity units (e.g. per 100): turn that into a price per unit.
    unitPrice: perUnit(textOf(line.Price?.PriceAmount) ?? "0", textOf(line.Price?.BaseQuantity)),
    amount: textOf(line.LineExtensionAmount) ?? "0",
  };
}

/** Peppol price per BaseQuantity units → price per 1 unit (kept exactly as written when it's already per unit). */
function perUnit(price: string, baseQuantity: string | null): string {
  if (!baseQuantity || new Decimal(baseQuantity).eq(1)) return price;
  return new Decimal(price).div(baseQuantity).toString();
}

/** The tax total in the invoice currency (Peppol can add a second one in the tax currency), else the first. */
function taxTotal(root: Node, currency: string): Node {
  const taxTotals: Node[] = root.TaxTotal ?? [];
  return taxTotals.find((total) => total.TaxAmount?.["@_currencyID"] === currency) ?? taxTotals[0];
}

/** Part already paid (deposit): the amount due is less than the total, so a person should look. */
function prepaidNote(totals: Node): string[] {
  const prepaid = textOf(totals.PrepaidAmount);
  if (new Decimal(prepaid || "0").isZero()) return [];
  return [`prepaid amount ${prepaid} (amount due ${textOf(totals.PayableAmount) ?? "?"})`];
}
