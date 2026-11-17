import { Decimal } from "decimal.js";

/** Builds a minimal InvoiceNow (Peppol BIS Billing, SG) UBL invoice, for samples and tests. */
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

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export function buildUbl(x: UblInput): string {
  const pct = new Decimal(x.gstPercent ?? "9");
  const lineAmounts = x.lines.map((l) => new Decimal(l.qty).times(l.price));
  const subtotal = lineAmounts.reduce((a, b) => a.plus(b), new Decimal(0));
  const tax = new Decimal(money(subtotal.times(pct).div(100)));
  const total = subtotal.plus(tax);
  const tag = (name: string, d: Decimal) => `<cbc:${name} currencyID="SGD">${money(d)}</cbc:${name}>`;

  const lines = x.lines
    .map(
      (l, i) => `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="H87">${l.qty}</cbc:InvoicedQuantity>
    ${tag("LineExtensionAmount", lineAmounts[i])}
    <cac:Item>
      <cbc:Name>${l.name}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>SR</cbc:ID><cbc:Percent>${pct}</cbc:Percent><cac:TaxScheme><cbc:ID>GST</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>${tag("PriceAmount", new Decimal(l.price))}</cac:Price>
  </cac:InvoiceLine>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:sg:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${x.id}</cbc:ID>
  <cbc:IssueDate>${x.issueDate}</cbc:IssueDate>
  <cbc:DueDate>${x.dueDate}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SGD</cbc:DocumentCurrencyCode>
  <cac:OrderReference><cbc:ID>${x.poNumber}</cbc:ID></cac:OrderReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0195">SGUEN${x.supplier.uen}</cbc:EndpointID>
      <cac:PartyName><cbc:Name>${x.supplier.name}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${x.supplier.street}</cbc:StreetName>
        <cbc:CityName>Singapore</cbc:CityName>
        <cbc:PostalZone>${x.supplier.postalZone}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SG</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cbc:CompanyID>${x.supplier.uen}</cbc:CompanyID><cac:TaxScheme><cbc:ID>GST</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${x.supplier.name}</cbc:RegistrationName><cbc:CompanyID>${x.supplier.uen}</cbc:CompanyID></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Petal Lane Florist Pte. Ltd.</cbc:Name></cac:PartyName>
      <cac:PartyLegalEntity><cbc:RegistrationName>Petal Lane Florist Pte. Ltd.</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${x.bank.account}</cbc:ID>
      <cbc:Name>${x.bank.holder}</cbc:Name>
      <cac:FinancialInstitutionBranch><cbc:ID>${x.bank.swift}</cbc:ID></cac:FinancialInstitutionBranch>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    ${tag("TaxAmount", tax)}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    ${tag("LineExtensionAmount", subtotal)}
    ${tag("TaxExclusiveAmount", subtotal)}
    ${tag("TaxInclusiveAmount", total)}
    ${tag("PayableAmount", total)}
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>
`;
}
