import { useEffect, useState } from 'react';

/** 外观：跟随系统 / 光明 / 深色（每台设备各自记住） */
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'zq.theme';
const listeners = new Set<(p: ThemePref) => void>();

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

const systemDark = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

export function resolvedTheme(p: ThemePref = getThemePref()): 'light' | 'dark' {
  return p === 'system' ? (systemDark() ? 'dark' : 'light') : p;
}

export function applyTheme(p: ThemePref = getThemePref()) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (p === 'system') delete root.dataset.theme;
  else root.dataset.theme = p;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', resolvedTheme(p) === 'dark' ? '#1d1a4a' : '#2f2a86');
}

export function setThemePref(p: ThemePref) {
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {}
  applyTheme(p);
  listeners.forEach((f) => f(p));
}

export function useTheme(): [ThemePref, (p: ThemePref) => void, 'light' | 'dark'] {
  const [p, setP] = useState<ThemePref>(getThemePref);
  const [, force] = useState(0);
  useEffect(() => {
    listeners.add(setP);
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onChange = () => {
      applyTheme();
      force((n) => n + 1);
    };
    mq?.addEventListener?.('change', onChange);
    return () => {
      listeners.delete(setP);
      mq?.removeEventListener?.('change', onChange);
    };
  }, []);
  return [p, setThemePref, resolvedTheme(p)];
}
