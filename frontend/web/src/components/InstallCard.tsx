'use client';

import { usePwa } from '@/providers/PwaProvider';
import { Icon } from './Icon';

/** "Get the app" prompt: native install button on Chrome/Android, Share-sheet hint on iOS. */
export function InstallCard({ compact = false }: { compact?: boolean }) {
  const pwa = usePwa();
  if (pwa.standalone || (!compact && pwa.dismissed)) return null;
  if (!pwa.canPrompt && !pwa.ios) return null;

  return (
    <div className="card install">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icons/icon-192.png" alt="" width={44} height={44} />
      <div className="row-main">
        <p className="row-title">Get the VOLTEX app</p>
        <p className="row-sub">Opens full-screen, right from your home screen.</p>
      </div>
      {pwa.canPrompt ? (
        <button className="btn sm" onClick={() => void pwa.install()}>
          Install app
        </button>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          Tap Share, then “Add to Home Screen”.
        </p>
      )}
      {!compact && (
        <button className="icon-btn" aria-label="Not now" onClick={pwa.dismiss}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
