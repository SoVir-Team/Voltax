# minisign interoperability fixtures

Made with the real `minisign` 0.11 (Debian 12 package) in a throwaway container, so the Node
verifier in `src/minisign.ts` is checked against the reference tool rather than against itself.

- `test.pub`: a **throwaway test key** (id `F0F24D409A9E93CB`). Its secret key was created without a
  password inside the container and discarded with it. It is not the VOLTEX release key and must
  never be trusted anywhere outside these tests.
- `release.json`: a sample hub release manifest (fake digests).
- `release.json.minisig`: default (prehashed, BLAKE2b-512) signature, trusted comment `voltax hub 1.4.0`.
- `release.json.legacy.minisig`: legacy (`-l`, not prehashed) signature of the same file.

Both signatures were verified with `minisign -V -p test.pub` before being copied here.
