# README media

These assets support the [main project README](../../README.md). All are stored in the repository; readers do not need an external image host to view the product illustrations and captures.

## Provenance

The interface images were captured from the actual customer and company applications running locally on **28 October 2026**. The build used the repository's existing development simulators: real web/service code with simulated devices, hubs, households, staff, support responses, and releases. Customer examples include illustrative schedules, a motion rule, room labels, and a device-scoped family member created through the local API.

The company capture used a separate local preview instance and throwaway demo accounts. These are not photographs of a Raspberry Pi or ESP32, production customer records, public cloud deployment evidence, or proof of electrical operation. No production credential is intentionally included in the images. Account/household labels visible in the company images are demonstration identities.

## Illustrations

| File | Meaning |
|---|---|
| `voltex-banner.svg` | Editorial cover illustration; local-first control and owner-approved support |
| `architecture.svg` | Home control path, direct GPIO path, and optional cloud/company boundary |
| `control-workflow.svg` | Six steps from command submission to reported-state presentation |
| `project-status.svg` | Built software, integration foundations, and pending acceptance; no invented completion percentage |

These SVGs contain text/vector shapes, accessible titles/descriptions, and no embedded script or remote asset dependency. The cover is an illustration, not an application screenshot or a hardware product photograph.

## Customer captures

| File | Screen |
|---|---|
| `customer-pairing.png` | One-time pairing form before credentials are entered |
| `customer-home.webp` | Household summary, rooms, search/filter and entity tiles |
| `customer-device.webp` | Kitchen switch after the simulator reported on |
| `customer-schedules.webp` | Daily schedules and add form |
| `customer-automations.webp` | Trigger/action rule and add form |
| `customer-access.webp` | Household roles, device-scoped access and support-session visibility |
| `customer-hub.webp` | Health, updates, notifications, appearance and installer guidance |
| `customer-mobile.webp` | Narrow customer viewport in light appearance |
| `customer-mobile-dark.webp` | Narrow customer viewport in dark appearance |

Room and device names, counters, timestamps and session countdowns reflect the running simulator at capture time. The development data contains example support history as well as a current request; the screenshot does not establish a live production support session.

## Company captures

| File | Screen |
|---|---|
| `admin-overview.webp` | Company summary as a demonstration super admin |
| `admin-homes.webp` | Installation directory |
| `admin-fleet.webp` | Fleet counts and rollout controls |
| `admin-releases.webp` | Signed release registry and registration form |
| `admin-audit.webp` | Security audit and checkpoint section |
| `admin-staff.webp` | Staff management |
| `admin-settings.webp` | Account, password, notification and appearance settings |

Not every role or portal interaction is shown. Super-admin screenshots must not be interpreted as demonstrating support staff's device-control tools: those require a different role, assignment, and owner-approved grant.

## Animation and static alternative

`device-control.gif` combines three real device-screen captures:

1. `control-off.webp` — device reported off.
2. `customer-device.webp` — after an actual interface click, the simulated ESP32 reported on.
3. `control-return-off.webp` — after another interface action, it reported off again.

Captures are proportionally fitted within a labeled presentation frame. Playback is deliberately paced for explanation; it is **not** a screen recording at original speed or a measured latency result. The GIF loops. Readers who prefer a static image can open [the reported-on frame](customer-device.webp).

`appearance-demo.gif` alternates the light and dark mobile captures for 2.4 seconds each. It is an explanatory comparison, not a recording of the theme transition. The original static images remain available in the main README.

There are **18 interface captures, four SVG illustrations, and two GIFs**. Regeneration of the pictures is not part of the application build and introduces no runtime dependency. New screenshots should use fresh local demonstration data and must be reviewed for credentials, setup links, pairing codes, private records, and misleading readiness claims before publication.
