<div align="center">

<img src="docs/media/voltex-banner.svg" alt="VOLTEX — your home, your control. Local-first home automation with owner-approved support." width="100%" />

# VOLTEX Home Automation

**Everyday control at home. Support with your permission. Software built to manage both.**

[Explore the interface](#see-the-product) · [Understand the workflow](#how-it-works) · [View the architecture](#architecture) · [Check project status](#built-verified-and-pending) · [Run the demo](#run-it-locally)

[![CI](https://github.com/SoVir-Team/Voltax/actions/workflows/ci.yml/badge.svg)](https://github.com/SoVir-Team/Voltax/actions/workflows/ci.yml)
![Architecture: local first](https://img.shields.io/badge/architecture-local_first-0b8cc8)
![Interfaces: two PWAs](https://img.shields.io/badge/interfaces-two_PWAs-147a63)
![Stage: software prototype](https://img.shields.io/badge/stage-software_prototype-b07812)
![Hardware: validation pending](https://img.shields.io/badge/hardware-validation_pending-986144)

</div>

VOLTEX connects the switches in a home to a simple app and a small local home server. People can turn devices on and off, organize rooms, set daily schedules, build simple automations, and choose who may control which devices. A separate company portal helps VOLTEX manage installations, support requests, staff, software releases, and groups of hubs.

**The home runs locally.** Everyday app control, schedules, and automations use the home's Raspberry Pi hub rather than depending on a cloud service. An optional cloud connection adds staff support and fleet operations. The owner decides whether support may act inside the home.

> **Current level — 29 October 2026:** working customer and company web applications, hub and cloud services, automated tests, local simulators, and deployment tooling. **Real Raspberry Pi/ESP32 acceptance and production operation are still pending.** Screenshots below show running software with simulated homes and devices; they are not photographs or proof of a deployed installation.

## Start here

| If you want to… | Go to… |
|---|---|
| Understand the product without technical background | [The home experience](#the-home-experience) |
| See the actual application | [Screenshots and animated demonstration](#see-the-product) |
| Understand who can access a home | [People, permissions, and privacy](#people-permissions-and-privacy) |
| Follow a switch, support request, or update from start to finish | [How it works](#how-it-works) |
| Review engineering choices and technologies | [Architecture](#architecture) and [technology stack](#technology-stack) |
| Know what is complete and what remains | [Built, verified, and pending](#built-verified-and-pending) |
| Try it on a computer | [Run it locally](#run-it-locally) |

## The home experience

Imagine arriving home: you open VOLTEX, see your rooms, and turn on the kitchen light. You can schedule the living room lights for the evening, give a family member access to selected devices, and approve a support session if something needs attention.

| Everyday need | What VOLTEX provides | Where you see it |
|---|---|---|
| “Which devices are on?” | Reported switch state, device availability, and a household summary | **Home** |
| “Find the bedroom lamp.” | Search by device/room and filter All, On, Off, or Offline | **Home** |
| “Put this control in the kitchen.” | Owner-editable control names and a device room label | **Device detail** |
| “Turn the lights on every evening.” | Daily on/off schedules stored and executed on the hub | **Schedules** or **Device detail** |
| “When this sensor changes, turn on that switch.” | A state-change trigger and switch action, with an optional opposite action after a delay | **Automations** |
| “Let the family tablet control only these devices.” | Member invitations with device permissions that an owner can change | **Access** |
| “Make another person an owner.” | Local owner/member role changes with last-owner protection | **Access** |
| “Let support help for a limited time.” | Request details, named devices/actions, approval, rejection, and end-session control | **Access** |
| “Tell me when the hub needs attention.” | Notification opt-in for supported browsers; delivery needs internet | **Hub** |
| “Install an update only when I agree.” | Owner approval by default, or an owner-selected automatic update policy | **Hub** |
| “Use the app comfortably at night.” | Automatic, light, and dark appearance choices | **Hub** |
| “Keep the app on my phone.” | Installable Progressive Web App (PWA), where supported | **Home** / **Hub** |

The current device model supports **on/off switches and active/idle binary sensors**. Names such as fan or AC socket in the demo represent on/off controls; variable fan speed, dimming, temperature readings, and energy metering are not implemented.

### What works without the internet?

| Situation | App control | Schedules and automations | Physical wall button |
|---|---|---|---|
| Internet unavailable; home network and hub working | Designed to keep working locally | Run on the hub | Local ESP32 action |
| Cloud unavailable; local home system working | Local control remains independent | Run on the hub | Local ESP32 action |
| Hub unavailable | Unavailable; a cached app shell may still open | Cannot run while the hub is down | Designed to toggle the relay on the ESP32 |
| Wi-Fi/router unavailable | Unavailable | Cannot reach disconnected devices | Local GPIO path remains on the ESP32 |
| Device has no power | That device cannot be controlled | Commands cannot operate that device | That device cannot operate |

The physical-button behavior is configured in firmware but awaits hardware validation. Extended network loss can invoke ESPHome reboot behavior; uninterrupted manual operation and relay restoration must be established on the selected hardware. A powered local network is still needed for app control. Notifications and remote company support need internet.

## See the product

These are **actual interface captures**, taken from the local development applications on 28 October 2026. Homes, people, support sessions, releases, and device readings are demonstration data. Illustrations explain the architecture; they do not replace hardware evidence. [Media notes and provenance →](docs/media/README.md)

### Two interfaces, two responsibilities

| Customer app — inside the home | Company portal — installations and operations |
|---|---|
| ![Customer dashboard with room groups, search, reported switch state, and connection status](docs/media/customer-home.webp) | ![Company portal overview with homes, hub connectivity, support summary, and fleet versions](docs/media/admin-overview.webp) |
| **Your home:** rooms, switches, sensors, family access, local rules, and owner decisions. | **VOLTEX operations:** assigned homes, support requests, staff permissions, audit records, releases, and rollouts. |

### A real switch interaction, using a simulated device

<p align="center">
  <img src="docs/media/device-control.gif" alt="Actual VOLTEX device screen showing reported Off, then On after an app command, then Off again." width="860" />
</p>

The GIF uses three real interface captures, paced for explanation. It shows the app and simulator exchanging commands and reports; its playback speed is not a latency benchmark. [Static on-state image →](docs/media/customer-device.webp)

### The same customer app on a phone

<p align="center">
  <img src="docs/media/customer-mobile.webp" alt="Customer app in a narrow mobile viewport with light appearance" width="280" />
  &nbsp;&nbsp;
  <img src="docs/media/customer-mobile-dark.webp" alt="Customer app in a narrow mobile viewport with dark appearance" width="280" />
</p>

<details>
<summary><strong>See the light and dark appearance comparison</strong></summary>

<p align="center">
  <img src="docs/media/appearance-demo.gif" alt="Actual mobile interface captures alternating between light and dark appearance in the local simulator" width="320" />
</p>

This comparison combines the two static captures above; it is an explanatory slideshow, not a recording of the theme transition.

</details>

<details>
<summary><strong>Open the complete customer interface gallery</strong></summary>

| Pairing | Device detail |
|---|---|
| ![One-time pairing code and browser-name form](docs/media/customer-pairing.png) | ![Device detail with reported On state, control, room, and per-device schedules](docs/media/customer-device.webp) |
| Connect a browser using a short-lived, single-use code. | Inspect and control one entity, rename it, assign its device to a room, and add schedules. |

| Daily schedules | Automations |
|---|---|
| ![Daily schedules list and 12-hour scheduling form](docs/media/customer-schedules.webp) | ![State-triggered automation and action form with optional return duration](docs/media/customer-automations.webp) |
| Choose a time, switch, and on/off action. | Choose a trigger, an action, and an optional return delay. |

| Family and support access | Hub, updates, notifications, and appearance |
|---|---|
| ![Access screen with client permissions and owner-controlled support sessions](docs/media/customer-access.webp) | ![Hub screen with health, update policy, notifications, appearance, and installation guidance](docs/media/customer-hub.webp) |
| Choose family permissions; review and end support access. | See local service health and make owner-level update decisions. |

</details>

<details>
<summary><strong>Open the company portal gallery</strong></summary>

| Homes | Staff |
|---|---|
| ![Company home directory with hub connectivity and home creation form](docs/media/admin-homes.webp) | ![Staff accounts, roles, setup status, and account creation form](docs/media/admin-staff.webp) |
| Track installations and navigate to a home's operational record. | Manage company accounts and role assignments. |

| Fleet | Signed releases |
|---|---|
| ![Fleet summary and staged rollout creation form](docs/media/admin-fleet.webp) | ![Release registry with signature upload and compatibility view](docs/media/admin-releases.webp) |
| Review software versions and manage staged deployment. | Register signed software and check compatibility. |

| Audit | Account settings |
|---|---|
| ![Audited operations and signed checkpoint section](docs/media/admin-audit.webp) | ![Company account settings with password, appearance, and notification controls](docs/media/admin-settings.webp) |
| Review recorded actions and verify audit integrity. | Manage the current staff account and browser preferences. |

</details>

## Everything visible in the interfaces

### Customer application

| Screen | Built into the current interface | Important boundary |
|---|---|---|
| **Pairing** | Hub identity, pairing code, browser name, connection/error feedback | Initial owner code comes from the installer CLI |
| **Home** | Live connection indicator, switch/online counts, room groups, search, state filters, switch tiles, sensor tiles, warnings | Displays last reported state, not measured electrical load |
| **Device detail** | Reported state, report age, online/offline status, switch action, rename/room form, schedules | Room assignment belongs to the parent device |
| **Schedules** | List, daily 12-hour time picker, switch/action selector, create, delete, enabled/paused display | General cron and update support exist in the API; edit/pause controls are not exposed in this screen |
| **Automations** | List, trigger entity/state, action switch/value, optional return seconds, create, delete | One trigger and one action; pending return timers do not survive a hub restart |
| **Access** | Client list, device scopes, invitations, remove access, promote/demote, support request/session/history panels | Only owners manage family access or approve/end support |
| **Hub** | Version, database/MQTT/clock health, uptime, update offers and policy, push opt-in, theme, installer guidance, sign-out | Unsupported browser environments explain why notifications cannot be enabled |
| **Across the app** | Installable shell, responsive layout, live events, pending/failure feedback, light/dark/system theme | Cached pages do not make an unreachable hub controllable |

### Company application

The portal changes its navigation and controls according to the signed-in staff role. Server permissions enforce those limits independently of the visible buttons.

| Screen | Built into the current interface |
|---|---|
| **Sign in** | Work email, password, and authenticator code |
| **Account setup** | One-time setup link, password selection, and two-factor enrollment |
| **Overview** | Home/hub counts, offline hubs, software versions, support and rollout summaries |
| **Homes** | Visible-home directory and permitted home creation |
| **Home detail** | Hub registration/credential rotation, connectivity, version, device availability, permitted home edits, assignments/contact access, support requests, hub audit copy |
| **Support access** | Pending/active/past requests, named actions/devices, duration, notification status, completion/revocation, command and notification history |
| **Approved support tools** | Requester-only device commands, permitted diagnostics, activity lookup where allowed, and hub restart where granted |
| **Fleet** | Aggregate health/version counts, rollout creation, and rollout list |
| **Rollout detail** | Plan, stage/state, per-hub outcomes, and permitted halt/resume/cancel actions |
| **Releases** | Signed manifest/signature upload, version registry, withdrawal, compatibility checks |
| **Audit** | Recorded actions, expandable record details, pagination, chain verification, signed checkpoints |
| **Staff** | Create/disable accounts, roles, setup links, credential resets; related home pages manage assignments |
| **Settings** | Account details, password change, notification opt-in, and appearance |

**Company support is not unrestricted customer remote access.** The implemented remote pathway is for assigned staff acting under owner-approved grants. A general homeowner cloud-control app and native Android/iOS wrappers are not delivered here.

## How it works

### 1. Installation and first use

```mermaid
flowchart LR
    A[Installer prepares the Raspberry Pi] --> B[Installs hub software and certificates]
    B --> C[Creates a unique device credential]
    C --> D[Flashes the ESP32 and checks the load]
    D --> E[Device connects and reports its entities]
    E --> F[Installer creates an owner pairing code]
    F --> G[Owner opens the app and pairs]
    G --> H[Owner names rooms and invites family]
```

The setup tooling exists. Physical installation, electrical checks, and acceptance remain to be carried out on a real target. Each new browser pairs separately; this is not an email/password household account system.

### 2. Turning a device on

![Six-step command flow from app tap through authorization, local MQTT, firmware report, SQLite, and live interface update](docs/media/control-workflow.svg)

```mermaid
sequenceDiagram
    actor Person
    participant App as Home app
    participant Hub as Local hub
    participant Broker as MQTT broker
    participant Device as ESP32
    Person->>App: Tap Turn on
    App->>Hub: Authenticated command + unique ID
    Hub->>Hub: Check permission, duplicate ID, deadline and availability
    Hub->>Broker: Publish ON without retention
    Broker->>Device: Deliver command
    Device->>Device: Change logical relay output
    Device-->>Broker: Report state
    Broker-->>Hub: Device state report
    Hub->>Hub: Store report and command result
    Hub-->>App: Live state/result events
    App-->>Person: Show reported state or failure
```

Commands are absolute on/off values, serialized per entity, and carry an expiry at the hub. Duplicate command IDs reuse the recorded outcome rather than intentionally executing twice. The engine also has an already-reported-state confirmation fallback. MQTT delivery is not physical load verification, and transport timing guarantees still need real-device fault tests.

### 3. Schedules and automations

| Example | What happens |
|---|---|
| “Living room lights on at 7 PM.” | The Pi's scheduler submits an on-command at the selected time in the hub's timezone. |
| “Motion turns on a light for 60 seconds.” | A live sensor state transition matches the rule; the hub submits on, then the opposite value after the delay. |
| “Someone presses the wall button.” | ESP32 firmware toggles its output directly and reports the new state when connected. |

Schedules and rules are saved on the hub. Missed schedule times are skipped after downtime. Retained MQTT snapshots and duplicate same-value reports do not trigger automations. Optional return timers are in memory, so they are not a safety timer for a heater, pump, or other critical load.

### 4. Getting support without handing over permanent control

```mermaid
flowchart TD
    A[Assigned support staff or installer requests access] --> B[Names reason, devices, actions and time window]
    B --> C[Signed request reaches the home hub]
    C --> D{Owner decides in the home app}
    D -->|Reject| E[No support access]
    D -->|Approve| F[Grant becomes active within its time window]
    F --> G[Required owner start notice is delivered]
    G --> H[Requester may use only the approved tools]
    H --> I[Hub checks the grant again before each action]
    I --> J[Actions and outcomes are audited]
    J --> K{Owner ends it, time expires, or staff finishes}
    K --> L[Access ends and queued commands are cancelled]
```

There is no staff-side Approve button that can substitute for the owner's decision. Members see that support is active. Ending access cannot undo a command already published to a device; in-flight actions are reported separately. Start-notice delivery is an additional cloud-side control gate, distinct from optional informational browser alerts.

### 5. Updating hubs in controlled stages

```mermaid
flowchart LR
    A[Register a signed release] --> B[Check compatible older hub versions]
    B --> C[Offer to one canary hub]
    C --> D[Apply each owner's update policy]
    D --> E[Privileged host updater rechecks signature]
    E --> F{Healthy on the new version?}
    F -->|Yes| G[Advance through configured rollout stages]
    F -->|No| H[Halt or roll back according to policy]
    G --> I[Record per-hub outcomes and audit]
    H --> I
```

The cloud registry and rollout engine exist, including canary/failure thresholds and halt/resume/cancel behavior. The hub defaults to owner approval. The root updater verifies signed releases and can recover to an earlier release. A successful simulated rollout is not proof of a real Pi update. ESP32 release registration exists, but firmware rollout is deliberately blocked pending hardware OTA validation.

## Architecture

![Local home architecture with customer PWA, Pi hub, Mosquitto, ESP32 and direct wall-button path; separate optional cloud and staff portal](docs/media/architecture.svg)

| Component | In plain language | Main responsibility |
|---|---|---|
| **Customer PWA** | The home's control panel | Pairing, devices, rules, access, owner decisions |
| **Pi hub** | The home's local coordinator | Permission checks, commands, reported state, schedules, automations, local audit |
| **Mosquitto** | The local message delivery service | Device connections and topic access restrictions |
| **ESP32 firmware** | The software inside a switch | GPIO output/input, local wall button, state reports |
| **Cloud platform** | Company coordination services | Staff identities, homes, assignments, support grants, releases, rollouts, audit and notifications |
| **Company PWA** | The staff workspace | Role-appropriate installation, support, and fleet screens |

### Where information lives

- **On the home hub:** reported device states, event history, schedules, automations, paired clients, member device permissions, local support decisions, and hub audit records.
- **In the cloud:** staff accounts, home/assignment records, latest permitted operational telemetry, support records, release/rollout state, notification records, and security audit copies/checkpoints.
- **Routine telemetry:** hub version, uptime, database/MQTT health, clock state, device IDs with online/offline flags, and update state. It excludes household on/off states, names, routines, and activity history.
- **Approved support responses:** detailed diagnostics or device-filtered activity can pass to the authorized requester. The response handling is designed not to retain those household response bodies in the cloud database.

The hub's optional outbound cloud link is off when `CLOUD_URL` is empty. Both web applications are static Next.js exports served alongside their respective APIs; the Pi does not need a separate Next.js server for its production UI.

### Devices and the prototype hardware

One physical device can expose several **entities**: for example, one relay switch and one button sensor. Entity IDs connect the UI, API, database, and MQTT protocol.

| Prototype element | Current configuration |
|---|---|
| Home server target | Raspberry Pi 4, Raspberry Pi OS Lite 64-bit |
| Device target | ESP32 development board, ESPHome with ESP-IDF |
| Relay output | GPIO26, one channel |
| Wall push button | GPIO27, pull-up input, 30 ms debounce, local toggle |
| BOOT test button | GPIO0, published binary sensor |
| Relay restoration | Saved-state restoration with default off; actual power-loss timing needs testing |
| Device transport | LAN MQTT on port 1883 in the prototype |
| Firmware updates | ESPHome password-protected OTA configuration; fleet OTA acceptance pending |

Use the firmware instructions for a **low-voltage test setup**. A generic relay module is not a complete electrical product design. The repository does not contain evidence of a certified mains installation, production PCB, or validated appliance load ratings.

## People, permissions, and privacy

| Person | What they can do | What does not follow from that role |
|---|---|---|
| **Home owner** | Control the home, manage family, rules, rooms, support consent, and update policy | Their household role does not grant company administration |
| **Family member** | See/control granted devices and view permitted rules; see support-session visibility | Cannot change ownership, support consent, rules, or updates |
| **Company super admin** | Manage staff, assignments, home metadata, releases, fleet and audit | Cannot request a support grant or control household devices |
| **Support staff** | Work with assigned homes; request owner-approved diagnostics/control/activity/restart as permitted | Assignment alone is not device-control permission |
| **Installer** | Work on assigned installations, register hubs, request permitted support tools | Cannot read household activity or bypass the owner's approval |

Permission rules are shared between services and enforced on the server. Signed cloud envelopes are checked for the target hub, signature, freshness, nonce replay, trusted time, actor, and grant scope. A company role never automatically becomes a household owner.

Security foundations include hashed pairing/client tokens, staff password hashing and authenticator-based two-factor login, protected staff sessions, per-device MQTT credentials, private hub HTTPS tooling, append-only audit mechanisms, signed checkpoints, and signed release verification. These controls exist in code; they do not establish a completed independent security assessment.

Detailed policies: [permission matrix](docs/security/permission-matrix.md), [threat model](docs/security/threat-model.md), [data classification](docs/security/data-classification.md), [audit threat model](docs/security/audit-threat-model.md), and [security policy](SECURITY.md).

## Technology stack

Versions below describe the repository's declared major versions, not a claim to use the latest available release.

| Layer | Technology used | Why it is here |
|---|---|---|
| **Both web interfaces** | Next.js 16 App Router, React 19, TypeScript, CSS | Structured screens with static export and responsive layouts |
| **Installable applications** | Web App Manifest, service workers, Web Push, VAPID | App-shell installation/caching and opt-in notifications |
| **Hub and cloud APIs** | Node.js 24+, Fastify 5, TypeScript | Local/cloud services and validated application interfaces |
| **Live local updates** | WebSocket through `@fastify/websocket` | Reported device and command events |
| **Validation and contracts** | Zod 4, shared TypeScript types and topic helpers | One interface definition across applications/services |
| **Hub storage** | SQLite, better-sqlite3, WAL, forward SQL migrations | Home-local persistent state and history |
| **Cloud storage** | PostgreSQL through `pg`; PGlite in local/test harnesses | Company records, assignments, grants, fleet and audit |
| **Scheduling** | Croner 9 | Hub-local time-based execution |
| **Device/cloud messaging** | MQTT, mqtt.js, Mosquitto; EMQX integration support | Device reports, signed cloud requests, scoped broker communication |
| **Embedded platform** | ESP32, ESPHome YAML, ESP-IDF | Relay/button firmware and Wi-Fi connectivity |
| **Notifications** | Nodemailer/SMTP, `web-push` | Owner notices and supported-browser alerts |
| **Cryptography** | Node crypto, Ed25519, SHA-256, scrypt, AES-256-GCM; minisign release format | Message signatures, audit evidence, credential/secret protection, release trust |
| **Audit archive integration** | S3-compatible API, versioning/Object Lock support | Separate audit export/checkpoint retention |
| **Pi operations** | Docker Compose, Bash, systemd, UFW, Avahi, OpenSSL | Installation, service supervision, firewall, discovery, TLS and recovery |
| **Testing** | Vitest 5, Aedes, temporary SQLite/PGlite, PostgreSQL/broker/service harnesses | Functional, permission, protocol and integration checks |
| **Delivery** | npm workspaces, GitHub Actions, GHCR, ARM64 Docker builds | Shared builds, checks, signed hub release workflow |

MQTT on the **device LAN is currently plaintext**. Production transport hardening, device secure boot/flash encryption, and certificate/client trust acceptance remain part of the pending work. Web Push and SMTP/S3 adapters need their real production services configured and verified.

## Built, verified, and pending

![Project readiness: working software, integration foundation, and pending real-world acceptance](docs/media/project-status.svg)

**Status vocabulary:** **Built** means the implementation exists. **Checked locally** means an executed check provides evidence on a development computer. **Pending acceptance** means production accounts, real hardware, field behavior, or broader validation are still required. No overall percentage is assigned because these are different kinds of completion.

| Area | Built so far | Current evidence / remaining gate |
|---|---|---|
| **Home application** | Pairing, control, rooms/search, schedules, simple rules, member scopes, support consent, updates, themes, PWA/push UI | Production build and representative simulator/browser captures; complete role/device/browser acceptance remains |
| **Hub services** | Local API/live events, SQLite, commands, rules, device permissions, audit, signed cloud-link intake, support/update services | Automated PC tests pass; real Pi/device/network acceptance pending |
| **Cloud services** | Staff MFA/session auth, homes, assignments, grants, notices, telemetry, audit/checkpoints, release registry, rollout engine | Automated tests and service harnesses exist; public production deployment not established |
| **Company portal** | Overview, homes/detail, support tools, fleet/rollout, releases, audit, staff, settings and PWA | Builds and representative pages captured; full interactive/role/browser coverage pending |
| **Device firmware** | One-channel ESPHome relay with local push button and published BOOT input | Configuration exists; compile/flash/bench acceptance not performed for this README |
| **Pi operations** | Provisioning, hardened containers, supervision, backups, signed updates and rollback tooling | Scripts and host-test harness exist; real device update/recovery/power-cut rehearsal pending |
| **Fleet updates** | Signed registration, compatibility, canary/stages, failure thresholds and owner policy | Software behavior tested; actual Pi installation and fleet operation pending |
| **ESP32 fleet OTA** | Signed firmware registry and board metadata | Rollout delivery intentionally refused until hardware OTA validation |
| **Notifications and archives** | SMTP, browser push, S3-compatible audit-export integrations | Local harness evidence is recorded; real providers, bucket policy, and push-service delivery still need verification |
| **Native mobile applications** | PWA interfaces available | Dedicated Capacitor Android/iOS wrappers and native local-CA trust remain pending |
| **Production quality** | Validation, permission tests, recovery/security foundations | Independent review, sustained load/endurance run, production runbooks/deployment and electrical acceptance remain open |

### Verification from this documentation session

Executed on the development computer on **28 October 2026**, before the final documentation update:

| Check | Observed result |
|---|---|
| `npm run build` | **Passed** for all five workspaces; both web apps statically exported |
| `npm run typecheck` | **Passed** across the workspaces |
| `npm test` | **444 passed, 11 skipped** |
| Test breakdown | Contracts **18**, hub **105**, cloud **304 passed + 11 skipped**, customer web **14**, company web **3** |
| Browser capture | Paired customer demo; opened representative customer/admin pages; exercised a simulated device on/off; captured narrow light/dark views |

The 11 skipped cases require separate PostgreSQL or service environments. The normal test command does not replace those runs. Earlier PostgreSQL, broker, SMTP, and S3-compatible test results are recorded in [the implementation progress log](docs/LOOP_PROGRESS.md); those are historical records, not integrations freshly rerun for this README.

The [physical acceptance register](docs/runbooks/milestone-1-results.md) still records **20 real-system checks as not yet run**, including internet-cut control, wall-button latency, power pulls, restoration, updates, rollback, and firewall exposure. Its original Milestone 2 entry gate remains unmet even though later software has been implemented. “Milestone 2 code exists” must not be read as “Milestone 1 hardware accepted.”

### What comes next

1. **Prove the physical home:** flash the actual ESP32, bench-test the selected relay/button/supply, and record Raspberry Pi acceptance evidence.
2. **Prove outage and recovery behavior:** extended Wi-Fi/broker loss, WAN disconnection, clock loss, power cuts, storage replacement, backups, and signed update/rollback.
3. **Complete interface acceptance:** every supported role and interactive flow, member visibility, support approval/revocation, mobile installation, notifications, accessibility, and browser compatibility.
4. **Harden production trust:** encrypted device transport, production certificate lifecycle, secure-boot/flash-encryption process, signing-key custody, and security review. The production release public key is still absent from `deploy/pi/keys/`; real signing setup and CI secrets must be completed.
5. **Complete production deployment:** real broker TLS, notification providers, protected audit storage, cloud deployment/runbooks, and monitored operation.
6. **Measure real limits:** define and execute sustained load/endurance tests before promising device counts, fleet capacity, latency, or availability.
7. **Deliver remaining product scope:** validated ESP32 fleet OTA, native wrappers/client trust, and any future general homeowner remote-control experience.

These are acceptance priorities, not delivery dates or claims that a production launch is scheduled.

## Run it locally

### Customer app and simulated home

Requires **Node.js 24 or newer** and npm. From the repository root:

```bash
npm install
npm run dev
```

Open **http://localhost:8080**. The terminal prints a temporary owner pairing code. Enter it in the app and name the browser. The simulator provides three devices across living room, kitchen, and bedroom, with five on/off switches and two binary sensors. These are simulations, not connected appliances.

For customer UI hot reload, leave that process running and open a second terminal:

```bash
npm run dev:web
```

The hot-reload UI is at **http://localhost:3000**, connected to the local development hub.

### Company portal and simulated cloud

```bash
npm run build
node backend/cloud/dev/dev-cloud.mjs --demo
```

Open **http://localhost:8090**. The demo prints the location of its generated staff accounts under the ignored `backend/cloud/.dev-data/` directory. It creates temporary admin/support/installer identities and sample homes/releases. Use the generated account credentials, and obtain its current demonstration authenticator code with:

```bash
node backend/cloud/dev/dev-cloud.mjs code admin@voltex.test
```

For company UI hot reload, keep the demo cloud running and start:

```bash
npm run dev:admin
```

The hot-reload portal is at **http://localhost:3001**. The default cloud demo uses port 8090; if another local service uses it, choose an available `PORT` for the demo and set `CLOUD_URL` accordingly for the hot-reload portal.

> The company demo simulates hub responses and owner approvals. It is separate from the customer demo. Running both does not automatically connect those two example homes into an end-to-end installation. Demonstration credentials, keys, release manifests, and approval shortcuts are for local development only.

To preview a signed support request and update offer in the customer app, after building:

```bash
node backend/hub/dev/dev-hub.mjs --demo
```

Stop the ordinary hub demo first so the ports are free. This mode uses a temporary signing key and the development data directory. It does not install a real hub release.

### Checks and integration harnesses

```bash
npm run typecheck
npm test
npm run build
```

Additional environment-dependent checks are available:

| Command | What it checks |
|---|---|
| `npm run test:host` | Host update-request handling in a container harness |
| `npm run test:pg` | Cloud behavior and database permissions against real PostgreSQL |
| `npm run test:brokers` | Broker interoperability/isolation harnesses |
| `npm run test:services` | SMTP and S3-compatible integration harnesses |

These commands need the services/tools described by their harnesses. None should be represented as physical relay testing. See [contributing guidance](CONTRIBUTING.md) for the normal development workflow.

## Install, maintain, and recover a real hub

The repository includes documented procedures for provisioning the Pi, signing/installing its local certificate, adding device credentials, flashing firmware, pairing an owner, updating software, backing up, and recovering storage.

| Task | Guide |
|---|---|
| Prepare a Raspberry Pi and first device | [Pi setup](docs/runbooks/pi-setup.md) |
| Flash the ESP32 configuration | [Firmware instructions](firmware/esphome/README.md) |
| Configure signed releases | [Release signing setup](deploy/pi/keys/README.md) |
| Install/update/roll back hub software | [Update and rollback](docs/runbooks/pi-update-rollback.md) |
| Back up or restore a hub | [Recovery](docs/runbooks/pi-recovery.md) |
| Understand operational scripts and physical checks | [Pi deployment reference](deploy/pi/README.md) |
| Record actual hardware results | [Acceptance register](docs/runbooks/milestone-1-results.md) |

Provisioning changes the host's packages, services, network rules, files, and Docker configuration. The real-hardware instructions are procedures to validate, not proof that a deployment has already succeeded. A backup kept only on the hub cannot protect against loss of that same storage device.

## Repository map

```text
.
├── frontend/
│   ├── web/                 Customer app + PWA, served by the home hub
│   └── admin/               Company portal + PWA, served by the cloud API
├── backend/
│   ├── hub/                 Local API, MQTT, SQLite, rules, grants, audit, updates
│   └── cloud/               Staff, homes, support, PostgreSQL, fleet, notifications, audit
├── shared/
│   └── contracts/           Schemas, types, permissions, MQTT/cloud/update contracts
├── firmware/
│   └── esphome/             ESP32 relay/button firmware configuration
├── deploy/
│   └── pi/                  Provisioning, Compose, certificates, services, recovery, tests
├── docs/
│   ├── media/               README illustrations, real screenshots, GIF, provenance
│   ├── security/            Permissions, threats, data classification and audit model
│   ├── adr/                 Architecture decisions
│   ├── runbooks/            Physical setup, updates, recovery and acceptance evidence
│   └── LOOP_PROGRESS.md     Software implementation/check evidence
├── tools/                   Development and host-test helpers
├── .github/                 CI and signed hub-release workflow
├── package.json             Five npm workspaces and shared commands
├── CONTRIBUTING.md
└── SECURITY.md
```

### Read further

| Reference | Use it for |
|---|---|
| [Documentation index](docs/README.md) | Find the supporting guides |
| [Implementation progress](docs/LOOP_PROGRESS.md) | Phase-by-phase work and recorded test evidence; checklist entries may lag current source |
| [Permission matrix](docs/security/permission-matrix.md) | Exact household/company role boundaries |
| [Shared contracts](shared/contracts/src/) | Enforceable schemas and permission definitions |
| [Hub source](backend/hub/src/) / [cloud source](backend/cloud/src/) | Runtime behavior |
| [Architecture decisions](docs/adr/) | Why local-first, static exports, and private hub TLS were chosen |
| [Initial architecture document](docs/architecture.md) | Original local-first design; its cloud-future descriptions predate the current cloud implementation |
| [Detailed Milestone 1 walkthrough](docs/project-guide.md) | Historical early implementation analysis; later cloud/UI/security changes supersede parts of it |
| [Media provenance](docs/media/README.md) | How the screenshots, diagrams, and animation were produced |

---

**VOLTEX** is the product brand. `voltax` remains the repository/package namespace, MQTT prefix, environment-variable prefix, and installed-command spelling. The current system is a substantial software implementation with a local-first architecture; hardware acceptance and production readiness remain explicit engineering work.
