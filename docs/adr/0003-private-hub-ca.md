# ADR 0003: Private, name-constrained CA for hub TLS

- **Status:** Accepted for Milestone 1; provisional until the Android/iOS client test passes
- **Date:** 2026-10-28

## Context

Apps must reach the hub over HTTPS on the home network with no internet. Let's Encrypt cannot issue
certificates for `.local` names or private IPs, and DNS-01 certificates for a public name pointing to a
LAN IP fail when DNS is unreachable and need online renewal. Trust-on-first-use pinning would replace
certificate validation, which we rule out.

## Decision

- A VOLTEX Hub CA (ECDSA P-256) with name constraints `.hub.voltax.internal` and `.local`, so a leaked
  key cannot impersonate any other site. The dev CA is created by `deploy/pi/make-dev-ca.sh`; production
  moves issuing to the cloud (Milestone 5).
- Each hub generates its private key on the Pi; the CA signs its CSR
  (`deploy/pi/issue-hub-cert.sh`). SANs: `<hubId>.hub.voltax.internal`, `<hostname>.local`. 800 days
  (under the iOS 825-day limit). Port 8443, TLS 1.2+.
- Native apps trust this CA **only** for hub connections, with normal chain, hostname and expiry checks,
  and also verify the hub ID they paired with. Browsers cannot scope trust to one site, so the
  guaranteed offline path is the Capacitor app; the browser PWA uses the hub page on trusted installer
  machines and the cloud for remote access.

## Consequences

- Verified on a PC with `deploy/pi/tests/tls-test.sh` (6/6 checks). **Not yet verified on Android or iOS.**
- Revoking a compromised hub certificate needs its own mechanism (planned for Milestone 5).
