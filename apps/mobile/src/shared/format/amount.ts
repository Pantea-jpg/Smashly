/**
 * Parses an amount typed by a person ("12", "12.5", "12,50", "€ 1.234,50") into integer
 * minor units. Returns null for anything that is not a non-negative amount with at most
 * two decimals. No floating-point arithmetic: the digits are combined as strings.
 */
export function parseAmountToMinor(input: string): number | null {
  const text = input.replace(/[€\s]/g, '');
  if (text === '') return null;
  const lastSep = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
  let whole = text;
  let fraction = '';
  if (lastSep !== -1 && text.length - lastSep - 1 <= 2) {
    whole = text.slice(0, lastSep);
    fraction = text.slice(lastSep + 1);
  }
  // Remaining separators can only be thousands separators.
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole || '0') || !/^\d{0,2}$/.test(fraction)) return null;
  const minor = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0') || '0');
  return Number.isSafeInteger(minor) && minor <= 100_000_000 ? minor : null;
}

/** Minor units → "12.50" for prefilling a field (dot, no currency). */
export function minorToInput(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}
