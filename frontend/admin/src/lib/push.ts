// Staff browser notifications (Web Push + VAPID). Needs the portal over HTTPS (or localhost).

export const pushSupported = (): boolean => typeof window !== 'undefined' && isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function subscribe(publicKey: string): Promise<PushSubscriptionJSON | null> {
  if ((await Notification.requestPermission()) !== 'granted') return null;
  const reg = await navigator.serviceWorker.ready;
  return (
    await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    })
  ).toJSON();
}
