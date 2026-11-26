export type CsvValue = string | number | boolean | null | undefined;

const BOM = String.fromCharCode(0xfeff);

/**
 * One CSV cell. Text that a spreadsheet would execute as a formula (=, +, @, tab/CR, or "-"
 * not followed by a digit) is prefixed with an apostrophe (OWASP "CSV injection").
 * Negative amounts such as "-12.50" stay numeric.
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^(?:[=+@\t\r]|-(?!\d))/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel opens accented names correctly. */
export function toCsv(header: string[], rows: CsvValue[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
