export const THEME_KEY = 'rstack-board:theme';
export type Theme = 'system' | 'light' | 'dark';

function asTheme(value: string | null): Theme | undefined {
  return value === 'system' || value === 'light' || value === 'dark' ? value : undefined;
}

/** The `?theme=` override in a page's query string, such as `?theme=dark`, if valid. */
export function themeFromUrl(search: string): Theme | undefined {
  return asTheme(new URLSearchParams(search).get('theme'));
}

/**
 * The theme to start with: a `?theme=` in the URL wins, then one remembered for this
 * session (sessionStorage), then the persisted choice (localStorage), then the system.
 */
export function initialTheme(search: string, session: string | null, stored: string | null): Theme {
  return themeFromUrl(search) ?? asTheme(session) ?? asTheme(stored) ?? 'system';
}

/** True while this tab follows a `?theme=` override, so the toggle leaves localStorage alone. */
export function hasSessionTheme(): boolean {
  return asTheme(window.sessionStorage.getItem(THEME_KEY)) !== undefined;
}
