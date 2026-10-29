'use client';

import type { ReactNode } from 'react';
import { SessionProvider } from './Session';
import { Shell } from './Shell';
import { ThemeProvider } from './Theme';
import { ToastProvider } from './Toast';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
