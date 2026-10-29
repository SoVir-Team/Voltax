'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type ToastFn = (message: string, kind?: 'info' | 'error') => void;
const ToastContext = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    kind: 'info' | 'error';
  } | null>(null);
  const show = useCallback<ToastFn>((message, kind = 'info') => setToast({ id: Date.now(), message, kind }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 5000 : 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.id} className="toast" data-kind={toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}>
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
