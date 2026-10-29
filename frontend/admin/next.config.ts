import type { NextConfig } from 'next';

// Static export: `next build` writes plain files to out/, which the VOLTEX cloud serves on the same
// origin as its API (strict same-origin cookies, no CORS).
const isDev = process.env.NODE_ENV === 'development';
const cloudUrl = process.env.CLOUD_URL ?? 'http://localhost:8090';

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  agentRules: false,
  // `next dev` only: API calls go through a rewrite to a local cloud.
  ...(isDev && {
    output: undefined,
    skipTrailingSlashRedirect: true,
    async rewrites() {
      return [{ source: '/api/:path*', destination: `${cloudUrl}/api/:path*` }];
    },
  }),
};

export default config;
