'use client';

import type { ReactNode } from 'react';
import { HubProvider } from './HubProvider';
import { PwaProvider } from './PwaProvider';
import { ThemeProvider } from './ThemeProvider';
import { ToastProvider } from './ToastProvider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <PwaProvider>
          <HubProvider>{children}</HubProvider>
        </PwaProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
