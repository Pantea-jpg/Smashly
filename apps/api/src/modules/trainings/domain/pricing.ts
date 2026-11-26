import type { PriceSource } from '@tw/contracts';

/**
 * D5: training override → user's standing price → training default.
 * D6: the result is snapshotted on the charge at finalization; later changes never touch it.
 */
export function resolvePrice(input: {
  defaultPriceMinor: number;
  standingPriceMinor?: number | null | undefined;
  overridePriceMinor?: number | null | undefined;
}): { priceMinor: number; source: PriceSource } {
  if (input.overridePriceMinor !== null && input.overridePriceMinor !== undefined) {
    return { priceMinor: input.overridePriceMinor, source: 'TRAINING_OVERRIDE' };
  }
  if (input.standingPriceMinor !== null && input.standingPriceMinor !== undefined) {
    return { priceMinor: input.standingPriceMinor, source: 'USER_STANDING_PRICE' };
  }
  return { priceMinor: input.defaultPriceMinor, source: 'TRAINING_DEFAULT' };
}
