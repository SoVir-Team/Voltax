# ADR 0001: Local-first hub on a Raspberry Pi

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

VOLTEX will run in 100+ homes. Home control must keep working when the internet or our cloud is down,
and commands must never run late or twice.

## Decision

Each home has a Raspberry Pi 4 hub that is the source of truth. It runs Mosquitto and one hub process
(REST + WebSocket API, command manager, schedules, automations, SQLite) in Docker. ESP32 devices
run ESPHome over MQTT. The cloud is optional and connects outbound from the hub (Milestone 2).

## Consequences

- Local control, schedules and automations work with no internet.
- Remote commands will go through the same command manager, so duplicate and expiry rules live in one place.
- Every hub must be provisioned, updated and backed up: see `deploy/pi` and the runbooks.
- The Pi has no real-time clock; without internet after a power cut, schedules can run at the wrong
  time until the clock syncs (the app shows a warning). Production hubs should add a DS3231 RTC.
