// Runs the Pi host-script tests in a throwaway Debian container (needs Docker).
//   npm run test:host
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const piDir = fileURLToPath(new URL('../deploy/pi', import.meta.url));
const script = 'apt-get update -qq && apt-get install -y -qq jq >/dev/null && bash /src/tests/host-scripts-test.sh';
const r = spawnSync('docker', ['run', '--rm', '-v', `${piDir}:/src:ro`, 'debian:12-slim', 'bash', '-c', script], { stdio: 'inherit' });
process.exit(r.status ?? 1);
