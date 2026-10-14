export type Theme = 'dark' | 'light';
const KEY = 'hlcc-theme';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; // dark is the default
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage can be blocked; the choice then lasts for this page view only */
  }
}
