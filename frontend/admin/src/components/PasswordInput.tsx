'use client';

import { useState, type InputHTMLAttributes } from 'react';

/** A password field with a Show/Hide button, so people can check what they typed. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-input">
      <input {...props} type={shown ? 'text' : 'password'} autoCapitalize="off" spellCheck={false} />
      <button type="button" className="password-toggle" aria-pressed={shown} aria-label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown((s) => !s)}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}
