'use client';

import { ScheduleList } from './ScheduleList';

/** Daily schedules. They run on the hub itself, so they keep working without internet. */
export function SchedulesScreen() {
  return (
    <div>
      <p className="eyebrow">Runs on your hub, even offline</p>
      <h1 className="title">Schedules</h1>
      <div className="card">
        <ScheduleList />
      </div>
      <p className="small muted">Missed times are not replayed after a power cut, so nothing switches unexpectedly late.</p>
    </div>
  );
}
