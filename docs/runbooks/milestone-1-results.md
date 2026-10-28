# Milestone 1: acceptance results

**Gate:** Milestone 2 starts only when tests 1–16 pass on real hardware.

Only record **PASS** with the command output pasted below the table. "Internet cut" means the router's
WAN cable is unplugged and `ping -c2 1.1.1.1` fails on the Pi.

| # | Test | Pass when | Result |
|---|---|---|---|
| 1 | Base OS | 64-bit Pi OS, `aarch64`, `throttled=0x0` | NOT YET RUN |
| 2 | Services up | both containers `healthy` | NOT YET RUN |
| 3 | Health over TLS | `status ok`, `mqtt up`, `db up` | NOT YET RUN |
| 4 | Pair + list devices | relay listed, `online: true` | NOT YET RUN |
| 5 | Local control | command `confirmed`; **[MANUAL]** relay clicks, load on | NOT YET RUN |
| 6 | Wall switch → app | `entity.state` event within 1 s | NOT YET RUN |
| 7 | Offline control (internet cut) | tests 3–6 pass | NOT YET RUN |
| 8 | Offline schedule | relay switches on time | NOT YET RUN |
| 9 | Offline automation (BOOT button) | relay on, off after 60 s | NOT YET RUN |
| 10 | Duplicate command | executed once | NOT YET RUN (covered by unit tests on PC) |
| 11 | Stale command | `410`, nothing published | NOT YET RUN (covered by unit tests on PC) |
| 12 | No stale replay | relay does not switch when the ESP32 returns | NOT YET RUN |
| 13 | Pi reboot | healthy < 2 min, state + pairing kept | NOT YET RUN |
| 14 | Power pull ×3 **[MANUAL]** | boots clean, `integrity_check` ok | NOT YET RUN |
| 15 | Hub down | wall switch still toggles relay | NOT YET RUN |
| 16 | ESP32 power cycle **[MANUAL]** | offline → online, relay restored | NOT YET RUN |
| 17 | Update | new version healthy, data intact | NOT YET RUN |
| 18 | Auto-rollback | back on previous version, data intact | NOT YET RUN |
| 19 | Power loss mid-update **[MANUAL]** | boot-check rolls back | NOT YET RUN |
| 20 | Firewall | only allowed ports reachable | NOT YET RUN |

## Verified on the development PC only (not on a Pi)

| Check | Result |
|---|---|
| Hub unit/integration tests (in-process MQTT broker, temp SQLite) | 39/39 pass |
| Contracts + web app unit tests | 4/4 and 10/10 pass |
| `deploy/pi/tests/tls-test.sh` against the hub on 127.0.0.1:18443 | 6/6 pass |
| Web app against the dev hub with simulated devices: pairing, live state, commands confirmed, schedules, offline app shell | pass (browser) |

## Scripted checks on the Pi (§6.2, §6.4)

| Script | Result |
|---|---|
| `deploy/pi/tests/perm-test.sh` | NOT YET RUN |
| `deploy/pi/tests/mqtt-acl-test.sh` | NOT YET RUN |
| `deploy/pi/tests/recovery-test.sh` | NOT YET RUN |
| `deploy/pi/tests/backup-restore-test.sh` | NOT YET RUN (test hub only) |
| `deploy/pi/tests/tls-test.sh` (from a LAN PC to the Pi) | NOT YET RUN on a Pi (6/6 on PC) |

## Output

<!-- Paste command output for each test here, newest first, with date and hub ID. -->
