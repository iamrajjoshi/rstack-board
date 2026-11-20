import { expect, it } from 'vitest';
import { initialTheme, themeFromUrl } from './theme';

it('reads a valid ?theme= and ignores anything else', () => {
  expect(themeFromUrl('?theme=dark')).toBe('dark');
  expect(themeFromUrl('?x=1&theme=light')).toBe('light');
  expect(themeFromUrl('?theme=system')).toBe('system');
  expect(themeFromUrl('?theme=blue')).toBeUndefined();
  expect(themeFromUrl('')).toBeUndefined();
});

it('prefers the URL, then the session, then the saved choice, then the system', () => {
  expect(initialTheme('?theme=dark', 'light', 'light')).toBe('dark');
  expect(initialTheme('', 'system', 'dark')).toBe('system');
  expect(initialTheme('?theme=bogus', null, 'light')).toBe('light');
  expect(initialTheme('', 'bogus', null)).toBe('system');
  expect(initialTheme('', null, null)).toBe('system');
});
