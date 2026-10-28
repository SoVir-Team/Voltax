'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'voltax.theme';
const ThemeContext = createContext<{ theme: ThemeChoice; setTheme(t: ThemeChoice): void }>({ theme: 'system', setTheme: () => {} });

/** Runs before first paint (inline in <head>) so a dark-mode user never sees a white flash. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${KEY}');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){}`;

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d1220' : '#ffffff');
}

/** Light, dark, or follow the phone. Stored in this browser only. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    setChoice(saved === 'light' || saved === 'dark' ? saved : 'system');
  }, []);

  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const follow = () => apply('system');
    mq.addEventListener('change', follow);
    return () => mq.removeEventListener('change', follow);
  }, [theme]);

  const setTheme = useCallback((t: ThemeChoice) => {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
    setChoice(t);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
