import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { updateStateSchema, type UpdateState } from '@voltax/contracts';

const resultSchema = z.object({
  version: z.string().max(32),
  state: updateStateSchema,
  at: z.number().int().optional(),
  message: z.string().max(500).optional(),
  rolloutId: z.string().max(64).optional(),
});

export type UpdateResult = z.infer<typeof resultSchema>;

/**
 * Hand-off between the unprivileged hub and the root updater on the Pi host.
 * The hub can only drop a request ({version}) into a folder. A root systemd path unit picks it up
 * and runs voltax-update, which verifies the minisign signature itself and refuses downgrades,
 * so a compromised hub process cannot install anything that VOLTEX did not sign.
 */
export class UpdateDropbox {
  constructor(private dir: string) {}

  request(version: string, rolloutId?: string): void {
    if (!/^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i.test(version)) throw new Error('invalid version');
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, '.request.json.tmp');
    writeFileSync(tmp, JSON.stringify({ version, ...(rolloutId ? { rolloutId } : {}), at: Date.now() }));
    renameSync(tmp, join(this.dir, 'request.json')); // atomic: the path unit never sees half a file
  }

  pending(): boolean {
    return existsSync(join(this.dir, 'request.json'));
  }

  result(): UpdateResult | null {
    const file = join(this.dir, 'result.json');
    if (!existsSync(file)) return null;
    try {
      const parsed = resultSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  state(): { state: UpdateState; version?: string } {
    if (this.pending()) return { state: 'requested' };
    const r = this.result();
    return r ? { state: r.state, version: r.version } : { state: 'idle' };
  }
}
