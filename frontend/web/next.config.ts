import type { NextConfig } from 'next';

// Static export: `next build` writes plain files to out/, which the Pi hub serves itself.
// No Node server is needed for the UI, so it works on the home network with no internet.
const isDev = process.env.NODE_ENV === 'development';
const hubUrl = process.env.HUB_URL ?? 'http://localhost:8080';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true, // out/schedules/index.html, served as /schedules/ by any static server
  images: { unoptimized: true },
  reactStrictMode: true,
  agentRules: false, // don't let `next dev` write AGENTS.md into the repo
  // `next dev` only (hot reload): REST goes through a rewrite to the dev hub, the WebSocket connects to it directly.
  ...(isDev && {
    output: undefined,
    skipTrailingSlashRedirect: true,
    env: { NEXT_PUBLIC_HUB_WS_ORIGIN: hubUrl.replace(/^http/, 'ws') },
    async rewrites() {
      return [{ source: '/api/:path*', destination: `${hubUrl}/api/:path*` }];
    },
  }),
};

export default config;
