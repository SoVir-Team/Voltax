# Permission matrix

The enforceable source is [`shared/contracts/src/permissions.ts`](../../shared/contracts/src/permissions.ts).
The cloud and hub APIs both read it, and tests enumerate every role × action. This page is the
human-readable copy; if they ever disagree, the code wins and this page is a bug.

**Deny by default.** An action not listed for a role is refused by the server. Hidden buttons in the
web apps are a convenience only.

## Two separate worlds

| Layer | Roles | Where they live | Enforced by |
|---|---|---|---|
| Platform (company) | `PLATFORM_SUPER_ADMIN`, `PLATFORM_SUPPORT`, `INSTALLER` | Cloud staff accounts | Cloud API on every request; the hub again for anything that reaches it |
| Household | `HOME_OWNER` (hub `owner`), `FAMILY_MEMBER` (hub `member`) | Each home's hub | Hub API and WebSocket on every request |

A platform role never becomes a household role. Staff reach a home's devices **only** through a
support grant that the home owner approved **on the hub**. The hub re-checks every request itself.

## Scopes

| Scope | Meaning |
|---|---|
| platform | Any home, but only company operations (never device control or household data) |
| assigned | Only homes the staff member is currently assigned to (assignment has a kind and an expiry) |
| grant | Assigned **and** an active, owner-approved grant naming this action and device, inside its time window |
| own | Only records this staff member created |
| all / granted | Household: every device / only devices the owner granted to this member |

## Platform roles

| Action | Super admin | Support | Installer |
|---|---|---|---|
| Staff: read / manage, role changes, credential reset | platform | — | — |
| Home assignments | platform | — | — |
| Homes: create / update metadata | platform | — | — |
| Homes: delete (only a home that never went live: no connected hub, no support history; audit trail kept) | platform | — | — |
| Homes: read operational metadata | platform | assigned | assigned |
| Home owner contact | — | assigned | assigned |
| Hubs: register (provisioning) | platform | — | assigned |
| Hubs/devices: connectivity, versions, sync and update health | platform | assigned | assigned |
| Installation records | — | — | assigned |
| Support grant: request | — | assigned | assigned |
| Support grant: read | platform | assigned | assigned |
| Support grant: revoke | platform | own | own |
| **Device command** | — | grant | grant |
| Detailed diagnostics (redacted) | — | grant | grant |
| **Household activity history** | — | grant | — |
| Hub restart | — | grant | grant |
| Hub software rollout | platform (hub applies only under the owner's update policy) | — | — |
| Firmware: read / manage | read+manage | read | read |
| Rollouts: read / manage | read+manage | read | — |
| Notification records | platform | assigned | — |
| Audit: read / verify | platform | — | — |
| Audit: archive or delete | **no API**: server CLI with a separate DB role, retention policy only | — | — |

**Super admins cannot request grants or control devices.** That is separation of duties: whoever
manages staff and assignments cannot also turn on lights in a customer's home.

## Household roles (on the hub)

| Action | Home owner | Family member |
|---|---|---|
| See / control devices | all | granted devices only |
| Rename / delete devices | yes | — |
| Schedules, automations: read | all | rules that touch only granted devices |
| Schedules, automations: change | yes | — |
| Event history | all | events of granted devices |
| Invite, revoke, set member devices, promote/demote | yes | — |
| Support grants: approve / reject / revoke | yes | — |
| Support grants: see that a session is active | yes | yes |
| Hub update policy and approvals | yes | — |
| Hub audit log | yes | — |

## Never remote

| Action | Why |
|---|---|
| Factory reset | Destroys the home's data and pairings; owner, on the hub, only |
| Promote to owner | Would let a remote party take over the home |
| Approve a support grant | Approval must come from the owner, not from whoever is asking |
| Emergency / break-glass access | Not implemented; see [threat-model.md](threat-model.md#break-glass) |

## Disruptive operations

| Operation | Who may start it | Customer approval |
|---|---|---|
| Device command | Support / installer | Grant with `device.command` for that device |
| Hub restart | Support / installer | Grant with `hub.restart` |
| Hub software update | Super admin, as a fleet rollout | The owner's local update policy: approve each update (default) or allow automatic updates |
| ESP32 firmware update | Super admin, as a firmware rollout | The same owner update policy; real flashing needs hardware validation |
| Device removal | Owner on the hub only (remote removal of credentials is an installer task on site) | n/a |
| Factory reset | Owner on the hub only | n/a |

## Changes take effect immediately

- **Cloud:** staff sessions are opaque tokens. The role, account status and assignments are re-read
  from the database on every request, so a role change, disablement or unassignment applies to the
  next request. Disabling a staff member also revokes their sessions and their open grants.
- **Hub:** a client token is checked on every request. Revoking a client closes its live sockets.
  Changing a member's devices applies to the next request and to their live event stream.
