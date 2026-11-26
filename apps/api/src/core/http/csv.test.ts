import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("http://evil")', `"'=HYPERLINK(""http://evil"")"`],
    ['+cmd', "'+cmd"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['-=1+1', "'-=1+1"],
  ])('neutralises formula %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('keeps negative amounts numeric and quotes separators', () => {
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell(-1250)).toBe('-1250');
    expect(csvCell('de Vries, Anna')).toBe('"de Vries, Anna"');
    expect(csvCell(null)).toBe('');
  });

  it('builds CRLF lines with a BOM', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('﻿a,b\r\n1,x\r\n');
  });
});
