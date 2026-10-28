# ADR 0002: Web app in Next.js + TypeScript, static export served by the hub

- **Status:** Accepted
- **Date:** 2026-10-28
- **Supersedes:** the plain HTML/JS `frontend/hub-ui` page

## Context

The team standardised on Next.js + TypeScript for the frontend. The app must open on the home network
with no internet, and later also run from the cloud and inside Android/iOS wrappers. The Pi should not
run a second Node server just for the UI.

## Decision

`frontend/web` is a Next.js App Router project with `output: 'export'`. `next build` produces plain
files (one `index.html` per route) that the hub serves from `/app/public`. Device pages use
`/device/?id=<entityId>` because a static export cannot pre-build a page per device.

A post-build step (`scripts/postbuild.mjs`) generates the service worker with every built file
precached under a content-hashed cache name, and maps Next.js prefetch files to the names the browser
requests (hosting platforms do this automatically; a plain static server does not).

## Consequences

- One codebase for the hub-served app, the future cloud app and the Capacitor mobile wrapper.
- No server-side rendering, API routes or middleware: all data comes from the hub API at runtime.
- The UI needs a build step; the hub's Docker image builds it in a separate stage.
- Types are shared with the hub through `shared/contracts`.
