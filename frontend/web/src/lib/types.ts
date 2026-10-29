// View types for hub resources. Wire types come from @voltax/contracts (shared with the hub).
import type { AutomationInput, Role, ScheduleInput } from '@voltax/contracts';

export type {
  ClientView,
  CommandView,
  DeviceGrantInput,
  GrantView,
  HubUpdatesView,
  UpdatePolicy,
  DeviceView,
  EntityView,
  HealthView,
  HubEvent,
  Role,
  WsServerMessage,
} from '@voltax/contracts';

export interface HubIdentity {
  hubId: string;
  name: string;
  version: string;
  /** Local launcher only: staff who sign in on this page go to this admin portal. */
  staffPortal?: string;
}

export interface PairResult {
  clientId: string;
  token: string;
  role: Role;
}

export interface Schedule extends ScheduleInput {
  scheduleId: string;
  version: number;
  updatedAt: number;
}

export interface Automation extends AutomationInput {
  automationId: string;
  version: number;
  updatedAt: number;
}

export interface Client {
  clientId: string;
  name: string;
  role: Role;
  createdAt: number;
  revokedAt: number | null;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}
