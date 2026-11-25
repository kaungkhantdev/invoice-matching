import { Decimal } from "decimal.js";

/** What goes on a sample UBL invoice. Subtotal, GST and total are worked out from the lines. */
export interface UblInput {
  id: string;
  issueDate: string;
  dueDate: string;
  poNumber: string;
  supplier: { name: string; uen: string; street: string; postalZone: string };
  bank: { account: string; holder: string; swift: string };
  lines: { name: string; qty: string; price: string }[];
  gstPercent?: string;
}

/** Singapore GST, when the input doesn't say. */
const DEFAULT_GST_PERCENT = "9";

/** Builds a minimal InvoiceNow (Peppol BIS Billing, SG) UBL invoice, for samples and tests. */
export function buildUbl(input: UblInput): string {
  const gstPercent = new Decimal(input.gstPercent ?? DEFAULT_GST_PERCENT);
  const lineAmounts = input.lines.map((line) => new Decimal(line.qty).times(line.price));
  const subtotal = lineAmounts.reduce((a, b) => a.plus(b), new Decimal(0));
  // GST is rounded to cents before it is added to the subtotal.
  const tax = new Decimal(money(subtotal.times(gstPercent).div(100)));
  const total = subtotal.plus(tax);
  const lines = input.lines.map((line, i) => invoiceLineXml(line, i + 1, lineAmounts[i], gstPercent)).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:sg:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${input.id}</cbc:ID>
  <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>
  <cbc:DueDate>${input.dueDate}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SGD</cbc:DocumentCurrencyCode>
  <cac:OrderReference><cbc:ID>${input.poNumber}</cbc:ID></cac:OrderReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0195">SGUEN${input.supplier.uen}</cbc:EndpointID>
      <cac:PartyName><cbc:Name>${input.supplier.name}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${input.supplier.street}</cbc:StreetName>
        <cbc:CityName>Singapore</cbc:CityName>
        <cbc:PostalZone>${input.supplier.postalZone}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SG</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cbc:CompanyID>${input.supplier.uen}</cbc:CompanyID><cac:TaxScheme><cbc:ID>GST</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${input.supplier.name}</cbc:RegistrationName><cbc:CompanyID>${input.supplier.uen}</cbc:CompanyID></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Industrial &amp; Commercial Facilities Management Pte Ltd</cbc:Name></cac:PartyName>
      <cac:PartyLegalEntity><cbc:RegistrationName>Industrial &amp; Commercial Facilities Management Pte Ltd</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${input.bank.account}</cbc:ID>
      <cbc:Name>${input.bank.holder}</cbc:Name>
      <cac:FinancialInstitutionBranch><cbc:ID>${input.bank.swift}</cbc:ID></cac:FinancialInstitutionBranch>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    ${amountXml("TaxAmount", tax)}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    ${amountXml("LineExtensionAmount", subtotal)}
    ${amountXml("TaxExclusiveAmount", subtotal)}
    ${amountXml("TaxInclusiveAmount", total)}
    ${amountXml("PayableAmount", total)}
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>
`;
}

/** One <cac:InvoiceLine>; lineNumber counts from 1. */
function invoiceLineXml(
  line: UblInput["lines"][number],
  lineNumber: number,
  amount: Decimal,
  gstPercent: Decimal,
): string {
  return `  <cac:InvoiceLine>
    <cbc:ID>${lineNumber}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="H87">${line.qty}</cbc:InvoicedQuantity>
    ${amountXml("LineExtensionAmount", amount)}
    <cac:Item>
      <cbc:Name>${line.name}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>SR</cbc:ID><cbc:Percent>${gstPercent}</cbc:Percent><cac:TaxScheme><cbc:ID>GST</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>${amountXml("PriceAmount", new Decimal(line.price))}</cac:Price>
  </cac:InvoiceLine>`;
}

/** An amount element in SGD, e.g. <cbc:TaxAmount currencyID="SGD">39.60</cbc:TaxAmount>. */
function amountXml(name: string, amount: Decimal): string {
  return `<cbc:${name} currencyID="SGD">${money(amount)}</cbc:${name}>`;
}

/** Rounded to cents, always with 2 decimals: 39.6 → "39.60". */
function money(amount: Decimal): string {
  return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
