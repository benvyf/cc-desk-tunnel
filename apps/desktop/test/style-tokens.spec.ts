import { test, expect } from '@playwright/test';

// Phase 3o (spec §3, audit K): the stylesheet's corners and stacking use the token tiers. A radius or z-index
// written as a literal that equals a tier should name the tier, so changing a tier changes every use of it.
test('radii and z-indexes that match a tier use its token', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).waitFor();
  const found = await page.evaluate(() => {
    const radii = new Set(['4px', '6px', '8px', '12px', '16px', '20px']);
    const tiers = new Set(['1', '10', '20', '30', '40', '50']);
    const literal: string[] = [];
    const tokens: Record<string, string> = {};
    const root = getComputedStyle(document.documentElement);
    for (const name of ['sticky', 'sidebar', 'popover', 'dialog', 'toast', 'content'])
      tokens[name] = root.getPropertyValue(`--z-${name}`).trim();
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules)
          visit((rule as CSSGroupingRule).cssRules);
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const property of [
          'border-radius',
          'border-top-left-radius',
          'border-top-right-radius',
          'border-bottom-left-radius',
          'border-bottom-right-radius',
        ]) {
          const value = rule.style.getPropertyValue(property);
          if (
            value &&
            !value.includes('var(') &&
            value.split(/\s+/).some((part) => radii.has(part))
          )
            literal.push(`${rule.selectorText} ${property}: ${value}`);
        }
        const z = rule.style.getPropertyValue('z-index');
        if (tiers.has(z)) literal.push(`${rule.selectorText} z-index: ${z}`);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        // A sheet from another origin cannot be read.
      }
    }
    return { literal, tokens };
  });
  expect(found.tokens).toEqual({
    sticky: '10',
    sidebar: '20',
    popover: '30',
    dialog: '40',
    toast: '50',
    content: '1',
  });
  expect(found.literal).toEqual([]);
});
