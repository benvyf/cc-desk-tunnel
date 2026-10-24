export const fontSizeOptions = {
  interface: { default: 14, min: 12, max: 20 },
  code: { default: 13, min: 10, max: 24 },
} as const;

export type FontSizes = { interface: number; code: number };
export const defaultFontSizes: FontSizes = { interface: 14, code: 13 };

export function validFontSize(key: keyof FontSizes, value: number): boolean {
  const { min, max } = fontSizeOptions[key];
  return Number.isInteger(value) && value >= min && value <= max;
}

export function readFontSizes(saved: unknown): FontSizes {
  const values = saved && typeof saved === 'object' ? (saved as Partial<FontSizes>) : {};
  return Object.fromEntries(
    (['interface', 'code'] as const).map((key) => [
      key,
      typeof values[key] === 'number' && validFontSize(key, values[key])
        ? values[key]
        : defaultFontSizes[key],
    ]),
  ) as FontSizes;
}
