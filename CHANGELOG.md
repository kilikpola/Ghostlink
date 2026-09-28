# Changelog

All notable changes to GhostLink are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The root package, `electron/`, `mobile/` and `gmp-core/` share one version
number (see [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md#versioning-policy)).

## [Unreleased]

### Fixed
- gmp-core tests timed out on GitLab CI: `claim-log-test.js` makes 100,000
  claims, each fsynced before it counts, which took 185 s on a disk-backed
  temp dir, past the runner's 180 s per-suite limit. `test/run-all.mjs` now
  gives suites a RAM-backed scratch directory (`/dev/shm` when writable, or
  `GMP_TEST_TMPDIR`). Every fsync still runs; the product code is unchanged.
  A suite killed by the limit now says so, instead of just stopping mid-output.
- GitLab `audit` job reports advisories as a warning and stays green, like the
  GitHub job.
- `claim-checkpoint-test.js` failed again on a Node 24 runner (one claim took
  70 ms). This was noise, not an inline checkpoint: the structural check
  passed in the same run. The timing sanity bound now uses the 99.9th
  percentile (< 20 ms) instead of the single slowest of 60,000 calls. With
  every CPU core busy, p99.9 stays under 3.5 ms while the worst single call
  reaches 31 ms. Inline writes are still caught structurally.

### Changed
- Desktop: Electron 28.3.3 → 44.4.5 and electron-builder 24 → 26. Electron 28
  (out of support since 2024) embedded Node 18, whose main process has no
  global `crypto`, so the desktop app's mesh node threw on every handshake.
  Electron 44 embeds Node 24; a two-node handshake in the main process, and
  against the packaged gmp-core, now completes.
- Versions follow the release tags: every package is `0.0.3` (they said
  `2.0.0`); Android `versionName` 0.0.3, `versionCode` 8.
- Minimum Node.js is 22 (Node 20 reached end-of-life in April 2026); CI runs
  Node 22 and 24.
- GitHub links point at `kilikpola/Ghostlink`.

### Added
- GitLab mirror (`gitlab.com/shadow_dancers/Ghostlink`) with its own pipeline
  (`.gitlab-ci.yml`). It runs the same test, bundle-sync, packaging and
  advisory audit jobs as GitHub CI, and deploys the web app to GitLab Pages
  from the default branch. Pages publishes only the files the app loads.
- CI and release workflows are published again. The release workflow now
  triggers on this project's un-prefixed tags (`0.0.4`) as well as `v*`.

### Removed
- `CODEBASE_AUDIT.md` (an outdated report that contradicted the code) moved
  to `docs/archive/`, which is not published.

## [0.0.3] - 2026-09-26

Production-readiness and security-audit release. Package manifests and the
Android build still said 2.0.0 in this release; see [Unreleased].

### Security
- Mesh handshake: fingerprints bound to public keys; impersonation during the
  handshake blocked; ECDH failures fail closed instead of deriving keys from
  public peer IDs.
- Replay protection: the `NonceStore` replay guard is actually constructed and
  wired in, backed by an append-only, individually authenticated session-key
  claim log with atomic, durable writes.
- Topology announcements are authenticated with Ed25519 — a peer can no longer
  poison mesh-wide routing.
- Local bridge: CSRF identity takeover via `/rotate-key` blocked, `Origin: null`
  refused by default, rotate-key uses a CSPRNG and the full BIP-39 list.
- File transfer is encrypted; workspace key spoofing fixed.
- `start_https.sh` no longer serves the whole repository.
- Web: `escapeHTML` fixed (was a no-op), HKDF-based v2 at-rest encryption.
- Desktop: CSP and permission-request hardening; seed phrase stored in the OS
  keychain.
- Mobile: keys no longer stored unencrypted,
  `storeKeyPair` throws on keystore failure, wiping the app clears the keystore
  identity, QR-scan crash loop fixed.
- Removed misleading UI: a false "Double Ratchet ACTIVE" panel and false
  end-to-end labels. Security labels are now derived from real session state.
- Guardian (social) recovery disabled until a real fragment transport exists.
- Client-side licensing documented as an accepted limitation (`SECURITY.md`).

### Added
- Ghost Address: short, stable identifiers for every identity, shared by web
  and mobile.
- Real mobile transport with app-layer AES-GCM over direct WebRTC.
- Shared BIP-39 wordlist, so phrases created on the web restore on mobile.
- LAN discovery, NAT detection, hole punching and public-peer support in
  gmp-core.
- CI (`.github/workflows/ci.yml`): on every push and PR to `main`, on Node 20
  and 22 — workspace install, gmp-core build, web bundle build, a
  bundle-sync gate that fails if the committed `app.bundle.js` differs from a
  fresh build, and the web, gmp-core and mobile test suites. Plus an
  `electron-builder --dir` packaging check that also verifies the packaged
  mesh core loads from its own bundled dependencies, and an advisory
  `npm audit` job.
- Release workflow (`.github/workflows/release.yml`) for `v*` tags: checks the
  tag against all four package versions, re-verifies bundle sync and tests,
  builds Windows (NSIS), macOS (DMG) and Linux (AppImage, deb) installers,
  and collects them with SHA-256 checksums. Publishing to GitHub Releases is
  wired up but disabled until the installers are code-signed.
- `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/PRODUCTION_READINESS.md`, and a
  vulnerability disclosure process with scope and a 90-day timeline in
  `SECURITY.md`.
- `.env.example` documenting every `GMP_*` environment variable and `PORT`.
- Root scripts: `install:gmp`, `build:gmp`, `test:web`, `test:gmp`,
  `test:mobile`, `ci`.

### Fixed
- `claim-checkpoint-test.js` Test 7 no longer times a checkpoint written inline
  by design, which made it fail on slower machines. It now yields like a real
  node, and it detects inline checkpoint writes structurally instead of by
  timing alone.
- `mobile/test/ghost-address.test.mjs` imported gmp-core from a hardcoded
  `/home/shadow/...` path, so it only passed on one machine. It now resolves
  the repo root relative to itself.
- LAN discovery now does what it was built for: a Ghost Address seen on the
  local network resolves with no mesh or public peer, and connecting to it
  dials the peer directly over the LAN. Beacons are unauthenticated, so the
  link is kept only if the handshake proves the expected NodeID. Previously
  discovered peers were never consulted. The test hid this by skipping on
  hosts without multicast, and CI's first real run caught it.
- CI's advisory `npm audit` job reports findings as warnings instead of
  showing a red check.
- `npm test` on a fresh clone: `pretest` now installs and compiles gmp-core
  (its `dist/` is gitignored, and it has its own lockfile, so a root `npm ci`
  never installed it and `tsc` failed against React Native's hoisted
  `@types/node`). `@noble/hashes` and `@noble/ciphers` are declared at the
  root, so `ghost-address-kdf` and `phrase-roundtrip` resolve them.
- `.gitignore` no longer ignores every `*.md` / `*.txt` file — new docs were
  silently dropped by `git add`. The ignore is scoped to `docs/archive/`.
  `.env` files are now ignored (`.env.example` excepted), as is
  electron-builder's `electron/dist/` output.
- Desktop packaging: the installed app could not find `index.html` or the
  mesh core, because electron-builder does not package `../` paths from
  `files`. The web payload and gmp-core now ship via `extraResources`, and
  `main.js` resolves them under `process.resourcesPath` when the checkout path
  is absent (development runs are unchanged). Mesh state moves to the per-user
  data directory in installed builds, whose install directory is read-only.
  gmp-core is loaded through a `file://` URL, which Windows requires for ESM
  `import()`.
- electron-builder no longer prunes the workspace's own devDependencies
  (electron, 7zip-bin) mid-build (`electron/scripts/prepare-packaging.cjs`).
- `.deb` builds: `electron/package.json` now has the `author.email` and
  `homepage` that electron-builder requires for Debian packages.
- Flaky mobile test: `recovery.test.mjs` checked that no phrase word appears
  in the whole recovery tag, but the constant `ghostlink:recovery:` prefix
  itself contains six BIP-39 words, so ~3.5% of random phrases failed. The
  check now applies to the phrase-derived digest.
- `package.json` `repository.url` points at the real repository.

### Changed
- `engines.node` is now `>=20.19.0` (was `>=18.0.0`, which never actually
  worked — see the Node 18 note in `CONTRIBUTING.md`).
- `electron`, `mobile` and `gmp-core` versions aligned with the root (`2.0.0`).
- Electron pinned to `28.3.3` for reproducible desktop builds.

### Removed
- Non-functional Signal / KeyManager code and 31 dead files (~13k lines).
- `.github/workflows/` (CI and release) and `.agents/skills/` are no longer
  published in the repository. Both are kept locally and gitignored.
  `npm run ci` runs the full check locally.

[Unreleased]: https://github.com/kilikpola/Ghostlink/compare/0.0.3...HEAD
[0.0.3]: https://github.com/kilikpola/Ghostlink/releases/tag/0.0.3
