# @voltax/contracts

The single source of truth for what the hub and its clients exchange. **TypeScript + zod.**

| File | What |
|---|---|
| `src/api.ts` | REST/WebSocket request schemas (validated by the hub) and response types (used by the web app) |
| `src/topics.ts` | MQTT topic layout and ON/OFF payload helpers (must match `firmware/esphome`) |

Change the contract here first; `npm run typecheck` then shows every place in the hub and the web
app that needs updating.
