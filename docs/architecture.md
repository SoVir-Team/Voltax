# Architecture

VOLTEX is **local-first**: each home's Raspberry Pi hub runs everything needed to control the home,
with or without internet. The cloud (Milestone 2+) only adds remote access and fleet management.

## Components

```
 Phone / laptop  ──HTTPS 8443──►  Raspberry Pi hub (Docker, network_mode: host)
 (web app / PWA)                  ├─ voltax-hub  (backend/hub, Node 24 + TypeScript)
                                  │   ├─ REST API /api/v1 + WebSocket /api/v1/ws (Fastify)
                                  │   ├─ command manager, schedules (croner), automations
                                  │   ├─ SQLite (WAL, synchronous=FULL), forward-only migrations
                                  │   └─ serves the web app (frontend/web static export)
                                  └─ mosquitto   per-device users + ACL, LAN only
                                          ▲ MQTT 1883 (LAN)
                                          │
                                  ESP32 (ESPHome, firmware/esphome): relay + wall switch.
                                  The wall switch toggles the relay on the ESP32 itself,
                                  so it works even when the hub is down.

 Later: hub ──outbound MQTT/TLS──► cloud (Hostinger VPS): remote access, fleet, OTA rings
```

| Path | Flow |
|---|---|
| Local (built) | App → hub REST → Mosquitto → ESP32 → relay; ESP32 reports state → hub → WebSocket → app |
| Remote (Milestone 2) | App → cloud API → cloud MQTT → hub cloud link → the **same** command manager → local MQTT → ESP32 |

## Rules that keep state honest

- **The UI shows reported state only.** A switch moves when the device reports it, never when tapped.
- **Commands** are absolute (on/off, never toggle), carry a client `commandId` (duplicates return the
  original result) and a TTL/`expiresAt` (late commands get `410` and are never sent). A command is
  `confirmed` only when the device reports the requested value after the send; otherwise `failed`.
- **No retained commands.** The hub publishes commands with retain=false and clears any retained command
  on connect, so a rebooting device never replays an old command.
- **Offline devices fail fast.** Missed schedules are not replayed after an outage.
- **Automations** fire only on live state changes, never on retained snapshots or duplicates.

## Failure behaviour

| Failure | Wall switch | App | Schedules / automations |
|---|---|---|---|
| Internet / cloud down | works | works on the home network | run on the hub |
| Hub down | works | unavailable | paused, not replayed |
| Wi-Fi down | works | unavailable | commands expire, never sent late |
| ESP32 down | that device unavailable | shows "offline" | commands to it fail fast |
| Power cut | relay restores last state | hub restarts automatically | hub clock may be wrong without internet (RTC module recommended) |

## Security (summary)

- **Pairing:** single-use 50-bit codes (10 min owner / 5 min member), stored hashed, rate-limited;
  256-bit client tokens stored hashed; owners can revoke clients instantly.
- **TLS on the hub:** a private, name-constrained VOLTEX Hub CA; the hub key is generated on the Pi.
  Public CAs cannot issue for `.local`/private IPs. Native apps trust this CA only for hub connections and
  also check the hub ID. See [ADR 0003](adr/0003-private-hub-ca.md).
- **MQTT:** one credential per device, ACL limits each device to its own topics. Port 1883 is
  plaintext on the LAN for the prototype only (see [SECURITY.md](../SECURITY.md)).
- **Containers:** non-root, all capabilities dropped, read-only root filesystem.
- **Updates:** signed releases, images pinned by digest, health-checked with automatic rollback.

## Web app delivery

The web app is Next.js + TypeScript exported as static files and served by the hub itself, so it
loads with no internet. A service worker precaches it (never the API). See
[ADR 0002](adr/0002-web-app-nextjs-static-export.md).
