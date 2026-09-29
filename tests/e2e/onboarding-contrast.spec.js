import { test, expect } from '@playwright/test';
import { withDedicatedServer } from './helpers.js';

// Issue #421: wizard buttons without .btn (Back, Skip for now) rendered light
// text on the browser's default white button in dark mode. Every enabled
// button in every wizard step must keep WCAG AA text contrast in each theme,
// including the worst case of a manual theme opposite to the OS scheme.

const PASSPHRASE = 'onboarding contrast fixture owner passphrase';
const COMBINATIONS = [
  { name: 'OS light, no override', os: 'light', theme: null },
  { name: 'OS dark, no override', os: 'dark', theme: null },
  { name: 'OS light, manual dark', os: 'light', theme: 'dark' },
  { name: 'OS dark, manual light', os: 'dark', theme: 'light' },
];

// Returns every visible, enabled button whose text contrast is below `min`.
async function lowContrastButtons(page, min = 4.5) {
  return page.evaluate((threshold) => {
    const parse = (value) => {
      const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(value);
      if (!match) throw new Error(`unparseable colour: ${value}`);
      const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
      return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
    };
    const over = (top, bottom) => top.slice(0, 3).map((channel, i) => channel * top[3] + bottom[i] * (1 - top[3]));
    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Composite the element's own background over its ancestors', ending on the canvas.
    const backgroundOf = (element) => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor);
        if (colour[3] > 0) layers.push(colour);
        if (colour[3] === 1) break;
      }
      // Canvas colour follows color-scheme; approximate it from the root's computed scheme.
      const dark = getComputedStyle(document.documentElement).colorScheme.split(/\s+/).join(' ') === 'dark';
      let result = dark ? [18, 18, 18] : [255, 255, 255];
      for (const layer of layers.reverse()) result = over(layer, result);
      return result;
    };
    const failures = [];
    for (const button of document.querySelectorAll('u2-onboarding button')) {
      const box = button.getBoundingClientRect();
      if (button.disabled || box.width === 0 || box.height === 0 || getComputedStyle(button).visibility === 'hidden') continue;
      const style = getComputedStyle(button);
      const bg = backgroundOf(button);
      const fg = parse(style.color);
      const text = over(fg, bg);
      const [hi, lo] = [luminance(text), luminance(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < threshold) failures.push({ label: (button.textContent || '').trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, color: style.color, background: style.backgroundColor });
    }
    return failures;
  }, min);
}

test.describe('onboarding wizard button contrast (#421)', () => {
  test('every enabled wizard button is legible on every step in each theme combination', async ({ page }) => {
    await withDedicatedServer(page, {}, async ({ baseURL }) => {
      await page.goto(baseURL);
      await page.locator('input[name="passphrase"]').fill(PASSPHRASE);
      await page.locator('form button[type="submit"]').click();
      await expect(page.locator('u2-onboarding')).toBeVisible();

      const problems = [];
      for (let step = 1; step <= 7; step++) {
        await expect(page.locator('.workspace__subtitle')).toContainText(`Step ${step} of 7`);
        // Let async step content (model form, connector cards, routine catalog) render.
        await page.waitForLoadState('networkidle');
        for (const { name, os, theme } of COMBINATIONS) {
          await page.emulateMedia({ colorScheme: os });
          await page.evaluate((value) => { if (value) document.documentElement.dataset.theme = value; else delete document.documentElement.dataset.theme; }, theme);
          for (const failure of await lowContrastButtons(page)) problems.push(`step ${step} [${name}] "${failure.label}" contrast ${failure.ratio} (${failure.color} on ${failure.background})`);
        }
        if (step < 7) await page.locator('u2-onboarding [data-next]').click();
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });
  });
});
