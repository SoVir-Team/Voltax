import { Suspense } from 'react';
import { DeviceScreen } from '@/features/devices/DeviceScreen';

// /device/?id=<entityId>: a query string, because a static export cannot pre-build a page per device.
export default function DevicePage() {
  return (
    <Suspense>
      <DeviceScreen />
    </Suspense>
  );
}
