const DEFAULT_WINDOW_TRANSPARENCY = 80;

export function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else if (theme === 'light') {
    root.classList.remove('dark');
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }
}

function clampTransparency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WINDOW_TRANSPARENCY;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function applyWindowTransparency(transparency: number) {
  const level = clampTransparency(transparency);
  const ratio = level / 100;
  const root = document.documentElement;

  const lightBgAlpha = 0.78 - ratio * 0.28;
  const lightSidebarAlpha = 0.62 - ratio * 0.28;
  const darkBgAlpha = 0.74 - ratio * 0.28;
  const darkSidebarAlpha = 0.58 - ratio * 0.24;

  root.style.setProperty('--glass-alpha-bg-light', lightBgAlpha.toFixed(2));
  root.style.setProperty('--glass-alpha-sidebar-light', lightSidebarAlpha.toFixed(2));
  root.style.setProperty('--glass-alpha-bg-dark', darkBgAlpha.toFixed(2));
  root.style.setProperty('--glass-alpha-sidebar-dark', darkSidebarAlpha.toFixed(2));
}
