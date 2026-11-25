import type { AnalyzeExpenseCommandOutput, ExpenseField } from "@aws-sdk/client-textract";

/** What we keep of one page's AnalyzeExpense answer: its fields (only what pickFields uses) and its text lines. */
export type PageResult = { fields: ExpenseField[]; lines: string[] };

/** One page's AnalyzeExpense answer, cut down to what we keep. */
export function pageResult(answer: AnalyzeExpenseCommandOutput): PageResult {
  return { fields: summaryFields(answer), lines: pageLines(answer) };
}

/** The invoice fields Textract found: only each field's type and value, with their confidence. */
function summaryFields(answer: AnalyzeExpenseCommandOutput): ExpenseField[] {
  return (answer.ExpenseDocuments ?? [])
    .flatMap((expenseDocument) => expenseDocument.SummaryFields ?? [])
    .map((field) => ({
      Type: { Text: field.Type?.Text, Confidence: field.Type?.Confidence },
      ValueDetection: { Text: field.ValueDetection?.Text, Confidence: field.ValueDetection?.Confidence },
    }));
}

/** The page's text lines, in reading order (a page can hold more than one expense document). */
function pageLines(answer: AnalyzeExpenseCommandOutput): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const expenseDocument of answer.ExpenseDocuments ?? []) {
    for (const block of expenseDocument.Blocks ?? []) {
      if (block.BlockType !== "LINE" || !block.Text) continue;
      if (block.Id && seen.has(block.Id)) continue;
      if (block.Id) seen.add(block.Id);
      lines.push(block.Text);
    }
  }
  return lines;
}
