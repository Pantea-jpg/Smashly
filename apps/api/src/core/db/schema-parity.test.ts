import { readFileSync } from 'node:fs';
import { SHARED_ENUMS } from '@tw/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The mobile app and API validate enums with packages/contracts; the database uses
 * Prisma enums. This test fails if the two drift apart.
 */
function parsePrismaEnums(schema: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  for (const match of schema.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const [, name = '', body = ''] = match;
    const values = body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter(Boolean);
    enums.set(name, values);
  }
  return enums;
}

const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');
const prismaEnums = parsePrismaEnums(schema);

describe('Prisma enums ⇄ shared contracts', () => {
  it('covers every Prisma enum in contracts', () => {
    expect([...prismaEnums.keys()].sort()).toEqual(Object.keys(SHARED_ENUMS).sort());
  });

  it.each(Object.entries(SHARED_ENUMS))('%s has identical values', (name, zodEnum) => {
    expect(prismaEnums.get(name)).toEqual(zodEnum.options);
  });
});
