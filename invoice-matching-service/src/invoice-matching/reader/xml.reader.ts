import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { XMLParser } from "fast-xml-parser";
import type { StandardInvoice } from "../invoice.schema.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

/** Text of an element, whether or not it has attributes (e.g. <TaxAmount currencyID="SGD">). */
function txt(v: Node): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in v) return String(v["#text"]);
  return null;
}

/** Peppol price per BaseQuantity units → price per 1 unit (kept exactly as written when it's already per unit). */
function perUnit(price: string, baseQuantity: string | null): string {
  if (!baseQuantity || new Decimal(baseQuantity).eq(1)) return price;
  return new Decimal(price).div(baseQuantity).toString();
}

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
    isArray: (name) =>
      ["InvoiceLine", "CreditNoteLine", "TaxTotal", "PartyTaxScheme", "PaymentMeans", "Delivery", "InvoicePeriod"].includes(name),
  });

  parse(xml: string): StandardInvoice {
    const doc = this.parser.parse(xml);
    const isCreditNote = doc.CreditNote != null;
    const root: Node = doc.Invoice ?? doc.CreditNote;
    if (!root) throw new Error("Not an InvoiceNow / UBL invoice (no <Invoice> or <CreditNote> root)");

    const currency = txt(root.DocumentCurrencyCode) ?? "";
    const party: Node = root.AccountingSupplierParty?.Party ?? {};
    const address: Node = party.PostalAddress ?? {};
    const gstScheme: Node = (party.PartyTaxScheme ?? [])[0];
    const account: Node = (root.PaymentMeans ?? [])[0]?.PayeeFinancialAccount;
    const taxTotal: Node =
      (root.TaxTotal ?? []).find((t: Node) => t.TaxAmount?.["@_currencyID"] === currency) ?? (root.TaxTotal ?? [])[0];
    const totals: Node = root.LegalMonetaryTotal ?? {};
    const lines: Node[] = root.InvoiceLine ?? root.CreditNoteLine ?? [];
    const customer: Node = root.AccountingCustomerParty?.Party ?? {};
    const deliveryAddress: Node = (root.Delivery ?? [])[0]?.DeliveryLocation?.Address;
    const period: Node = (root.InvoicePeriod ?? [])[0];

    return {
      documentType: isCreditNote ? "credit_note" : "tax_invoice",
      supplier: {
        name: txt(party.PartyLegalEntity?.RegistrationName) ?? txt(party.PartyName?.Name) ?? "",
        uen: txt(party.PartyLegalEntity?.CompanyID),
        gstRegNo: txt(gstScheme?.CompanyID),
        address:
          [address.StreetName, address.AdditionalStreetName, address.CityName, address.PostalZone]
            .map(txt)
            .filter(Boolean)
            .join(", ") || null,
      },
      bank: {
        accountHolder: txt(account?.Name),
        accountNumber: txt(account?.ID),
        swift: txt(account?.FinancialInstitutionBranch?.ID),
      },
      billTo: txt(customer.PartyLegalEntity?.RegistrationName) ?? txt(customer.PartyName?.Name),
      site: deliveryAddress
        ? [deliveryAddress.StreetName, deliveryAddress.AdditionalStreetName, deliveryAddress.CityName, deliveryAddress.PostalZone]
            .map(txt)
            .filter(Boolean)
            .join(", ") || null
        : null,
      // Peppol allows a period with only a start or only an end date.
      servicePeriod: (txt(period?.StartDate) ?? txt(period?.EndDate))?.slice(0, 7) ?? null,
      serviceRecords: [],
      otherInvoicesInFile: [],
      invoiceNumber: txt(root.ID) ?? "",
      invoiceDate: txt(root.IssueDate),
      dueDate: txt(root.DueDate),
      poNumber: txt(root.OrderReference?.ID),
      currency,
      pricesIncludeTax: false,
      lines: lines.map((l: Node) => ({
        description: txt(l.Item?.Name) ?? txt(l.Item?.Description) ?? "",
        quantity: txt(l.InvoicedQuantity ?? l.CreditedQuantity) ?? "0",
        // Peppol prices can be per BaseQuantity units (e.g. per 100): turn that into a price per unit.
        unitPrice: perUnit(txt(l.Price?.PriceAmount) ?? "0", txt(l.Price?.BaseQuantity)),
        amount: txt(l.LineExtensionAmount) ?? "0",
      })),
      subtotal: txt(totals.LineExtensionAmount) ?? "0",
      tax: txt(taxTotal?.TaxAmount) ?? "0",
      fees: txt(totals.ChargeTotalAmount) ?? "0",
      discounts: txt(totals.AllowanceTotalAmount) ?? "0",
      total: txt(totals.TaxInclusiveAmount) ?? txt(totals.PayableAmount) ?? "0",
      // Part already paid (deposit): the amount due is less than the total, so a person should look.
      uncertainFields: new Decimal(txt(totals.PrepaidAmount) || "0").isZero()
        ? []
        : [`prepaid amount ${txt(totals.PrepaidAmount)} (amount due ${txt(totals.PayableAmount) ?? "?"})`],
    };
  }
}
