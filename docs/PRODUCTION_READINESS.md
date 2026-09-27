# Production readiness

Status of the release-engineering audit of GhostLink (web, desktop, mobile,
gmp-core), what was changed, how to verify it, and what is still open.

_Last updated: 2026-09-27._

## Baseline (verified, unchanged)

These were already correct and are deliberately left alone:

- No hardcoded secrets in any source tree.
- Electron: `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, strict CSP.
- Web app: strict CSP meta tag, fonts and JS fully vendored (no CDN calls), no
  `unsafe-eval`.
- gmp-core compiles cleanly with `tsc`.
- Electron loads the repo-root `index.html` via
  `path.join(__dirname, '..', '..', 'index.html')` in development — still the
  first path tried.

No cryptographic code, CSP directive or Electron sandbox flag was changed.

## Findings

| # | Finding | Status |
|---|---------|--------|
| 1 | Fresh clone → `npm test` fails (gmp-core `dist/` not built; `@noble/hashes` / `@noble/ciphers` not declared at the root) | **Fixed** |
| 2 | Root `.gitignore` ignores every `*.md` / `*.txt`, so new docs are silently skipped by `git add` | **Fixed** |
| 3 | No CI/CD (`.github/workflows/` empty) | **Fixed** (briefly unpublished, restored 2026-09-27) |
| 4 | Root `repository.url` wrong (`ghostlink/ghostlink`) | **Fixed** |
| 5 | Version drift (root 2.0.0, others 1.0.0) and no CHANGELOG | **Fixed** |
| 6 | Electron packaging: `../index.html` / `../src/**` in `build.files` | **Fixed** (verified on Linux; Windows/macOS not yet run — see remaining work) |
| 7 | *New:* `engines.node >=18` is false — nothing runs on Node 18 | **Fixed** (now `>=22.12.0`) |
| 8 | *New:* flaky mobile test (~3.5% failure rate) | **Fixed** |
| 9 | *New:* `.deb` target could not build (missing `author.email` / `homepage`) | **Fixed** |
| 10 | *New:* desktop mesh node calls the global `crypto`, which Electron 28's main process does not have | **Fixed** (Electron 44) |
| 11 | *New:* LAN-discovered peers were never resolvable or dialable — caught by CI, where multicast works | **Fixed** |
| 12 | *New:* mobile test imported gmp-core from a hardcoded `/home/shadow/...` path | **Fixed** |
| 13 | *New:* claim-checkpoint Test 7 timed a by-design inline write; flaky on slow runners | **Fixed** |

### 1. Fresh clone → `npm test` fails

There were two causes, not one:

- `@noble/hashes` and `@noble/ciphers` were only reachable through the mobile
  workspace. Both are now root `devDependencies`.
- gmp-core is **not** a workspace. It has its own `package-lock.json`, so the
  root `npm ci` never installed its dependencies, and `tsc` fell back to the
  `@types/node@18` that React Native hoists to the root. That failed with
  `Cannot find name 'crypto'` (`src/identity.ts`, `src/cli.ts`). The new
  `install:gmp` script (`npm ci --prefix gmp-core`) installs gmp-core from its
  own lockfile, and `pretest` runs `install:gmp` then `build:gmp`.

`test/phrase-roundtrip.test.mjs` still writes a temporary
`mobile/.roundtrip-<pid>.mjs` so that `@noble/ciphers` resolves from the mobile
workspace. The test is unchanged. It deletes the stub itself, and the name is
now gitignored in case a crash leaves it behind.

### 2. `.gitignore`

The blanket `*.md` / `*.txt` rules are replaced with `docs/archive/*.md` and
`docs/archive/*.txt`. `docs/archive/DEPLOYMENT.md` is still tracked. Also added:
`.env` / `.env.*` (except `.env.example`) and `electron/dist/`.

### 3. CI/CD

> **History:** the workflows were unpublished on 2026-09-26 and restored on
> 2026-09-27. Before that, CI had caught three real defects that local runs
> missed (findings 11, 12 and 13). The test matrix is now Node 22 and 24.

- **`.github/workflows/ci.yml`** runs on every push and PR to `main`.
  - **test** (Node 22 and 24): `npm ci`, `install:gmp`, `build:gmp`, `build`,
    then the bundle-sync gate (`git diff --exit-code app.bundle.js`), then the
    web, gmp-core and mobile suites.
  - **desktop-package**: `electron-builder --dir` on Ubuntu. It asserts that
    `index.html`, `app.bundle.js`, `vendor/`, `assets/` and gmp-core are in
    `resources/`. It then copies the packaged gmp-core out of the checkout and
    imports it, which proves it loads from its own bundled dependencies.
  - **audit**: `npm audit --omit=dev --audit-level=high` for the root and
    gmp-core. It is advisory for now: findings become `::warning` annotations
    and the check stays green. See remaining work.
- **`.github/workflows/release.yml`** runs on `v*` tags.
  1. It checks that the tag equals all four package versions.
  2. It rebuilds and re-runs the bundle-sync gate and all tests.
  3. It builds installers on Ubuntu, Windows and macOS.
  4. It uploads everything as one artifact with `SHA256SUMS.txt`.

  The GitHub Release publish step is present but commented out until the
  installers are signed. The job already has `contents: write`.
  electron-builder always runs with `--publish never`, so a token in the
  environment can never trigger an accidental upload.

Both workflows pass `actionlint` 1.7 with 0 errors. The shellcheck integration
was not available locally, so the embedded shell snippets were only reviewed by
hand.

The Node matrix is 20 and 22, not 18 and 20; see finding 7.

### GitLab mirror

`gitlab.com/shadow_dancers/Ghostlink` mirrors GitHub. `origin` has two push
URLs, so one `git push` updates both. GitHub stays the primary: `SECURITY.md`,
package metadata, releases and the desktop installer workflow all live there.

`.gitlab-ci.yml` runs the same `test` (Node 22 and 24), bundle-sync,
`desktop-package` and advisory `audit` jobs as GitHub CI. A `pages` job then
publishes the web app to GitLab Pages from the default branch, after the tests
pass. Pages gets only what `index.html` loads (`index.html`,
`app.bundle.js`, `vendor/`, `src/`, `shared/`, `assets/` and `LICENSE`), not
the whole repository.

Verified locally:

- The YAML parses, and every stage, `needs` and `extends` reference resolves.
- The `pages` script, run on a clean `git archive` of `HEAD`, produces 57
  files (1.7 MB).
- All 105 relative references inside the published files resolve.
- Served over HTTP, every file loads with status 200. In a hidden Electron
  window the app renders its onboarding screen with 0 console errors.

Not verified: a run on GitLab's own runners. GitLab's lint needs an
authenticated API call, and there has been no pipeline run yet.

### 4. Repository URL

`package.json` now points at `https://github.com/kilikpola/Ghostlink`, as
does `homepage` in `electron/package.json`.

### 5. Versions and changelog

All four packages share one version, and it follows the GitHub release tags.
They are `0.0.3`; they said `2.0.0` until 2026-09-27, while the tags were
already `0.0.x`. The Android build follows too (`versionName` 0.0.3,
`versionCode` 8). `CHANGELOG.md` follows Keep a Changelog, with `[Unreleased]`
and `[0.0.3]` sections. The release workflow refuses a tag that does not match
all four versions.

### 6. Electron packaging

`build.files` is now `src/**`, `assets/**` and `package.json`. Everything from
outside `electron/` ships through `extraResources`:

| Source | Packaged location |
|--------|-------------------|
| `index.html`, `app.bundle.js`, `vendor/`, `src/`, `shared/`, `assets/` | `resources/webapp/` |
| `gmp-core/dist`, `gmp-core/package.json`, `public-peers.example.json` | `resources/gmp-core/` |
| `ws`, `@noble/curves`, `@noble/hashes` | `resources/gmp-core/node_modules/` |

`main.js` resolves each resource at the checkout path first
(`electron/src/../../`, which is how development works). If that is absent, it
looks under `process.resourcesPath`. It imports gmp-core through a `file://`
URL, because a bare absolute path breaks ESM `import()` on Windows. In
installed builds, `GMP_DATA_DIR` defaults to `<userData>/gmp-data`, because the
install directory is read-only.

`electron/scripts/prepare-packaging.cjs` runs before every `build:*` script.
It works around electron-builder, which would otherwise run a production
install that prunes the hoisted workspace devDependencies (electron, 7zip-bin)
mid-build.

Verified locally on Linux:

- `npm run build:dir` produces `resources/{app.asar,webapp,gmp-core}` with
  every file listed above.
- The packaged gmp-core imports from an isolated copy.
- `build:linux` produces the AppImage.
- The `.deb` failed first on missing metadata (finding 9, now fixed), then on
  this workstation only: electron-builder's bundled `fpm` needs
  `libcrypt.so.1`, which Arch provides only through `libxcrypt-compat`. Ubuntu
  runners have it.

### 7. Node 18 is not supported

Every suite fails on Node 18.20:

- gmp-core calls the global `crypto` (`identity.ts`), which is only defined by
  default from Node 19.
- The web and mobile tests load CommonJS-looking files as ES modules, which
  relies on ESM syntax detection (Node 20.19+ / 22.7+).

Node 18 is also end-of-life (April 2025). `engines.node` is now `>=20.19.0` in
the root and gmp-core — verified empirically: 18.20 fails on
`shared/wordlist.js` (ESM syntax detection) and 20.0 fails the same way, while
20.19 passes. CI tests the latest Node 20 and 22, so the matrix legs resolve
to >= 20.19 automatically. Fixing Node 18 would mean editing crypto code for
an EOL runtime, which is not worth it.

**Update (2026-09-27):** Node 20 reached end-of-life in April 2026, so the
floor is now `>=22.12.0` and CI tests Node 22 and 24. On a fresh clone, with
the original checkout hidden and multicast enabled, all suites pass on 22.23
and 24.21. `npm ci` succeeds with both npm 10.9 and npm 11.19.

### 8. Flaky mobile test

`mobile/test/recovery.test.mjs` asserted that no word of the phrase appears
anywhere in the recovery tag. The constant prefix `ghostlink:recovery:`
contains six BIP-39 words (`ghost`, `host`, `link`, `cover`, `over`, `very`),
so any random phrase containing one of them failed. That is about 3.5% of
runs, and it would have made CI randomly red. The assertion now checks the
phrase-derived digest after the prefix, which is what it was meant to protect.
It is no weaker: the prefix is a constant and carries no phrase material.

### 9. `.deb` metadata

electron-builder refuses Debian packages without `homepage` and an author
email. `electron/package.json` now has
`author: { name: "GhostLink", email: "ghostlink@proton.me" }` (the contact
already published in `SECURITY.md`), `homepage` and `license`.

### 10. Desktop mesh node and Electron 28 — FIXED

Electron 28 embeds Node 18.18. In its **main process**, `globalThis.crypto` is
`undefined`, as checked with a probe script under `electron/dist/electron`.
gmp-core's `generateEphemeralKeyPair` (`gmp-core/src/identity.ts:74`) calls
`crypto.getRandomValues`, so the desktop app's embedded mesh node should throw
on the first handshake. The web app and the standalone `gmp` CLI (Node ≥ 20)
are unaffected.

This was not fixed because this pass was not allowed to touch cryptographic
code. There are two options:

- **Recommended:** upgrade Electron to 30 or later (Node 20+, where the global
  exists), then re-run the packaging check on all three OSes. Electron 28 is
  also long out of security support.
- Import `webcrypto` explicitly in `identity.ts`
  (`import { webcrypto } from 'crypto'`). This is a one-line change, but it is
  in crypto code and needs a security reviewer.

A desktop smoke test should cover this whichever way it is fixed (see
remaining work).

**Fixed 2026-09-27** by upgrading Electron 28.3.3 → **44.4.5** (Node 24.21
inside) and electron-builder 24 → 26. The binary was downloaded from the
Electron release and checked against its published SHA-256. No crypto code
changed. Evidence:

- A probe script that starts two `GMPNodeManager`s in the Electron main
  process and dials one from the other. On Electron 28 it fails with
  `ReferenceError: crypto is not defined` at `identity.js:61` and the dial
  hangs. On Electron 44 the handshake completes and the authenticated peer ID
  matches.
- The same probe succeeds against an isolated copy of the packaged
  `resources/gmp-core` from `electron-builder --dir`.
- `main.js` uses no API removed between 28 and 44. The permission handlers,
  `setWindowOpenHandler`, `will-navigate`, `nativeImage` and the tray are
  unchanged.

The packaged app itself has not been launched. Launching it registers the
`ghostlink://` protocol handler on the desktop it runs on, so that stays in
the manual end-to-end checklist below.

### 11. LAN discovery was never wired in — FIXED

The first CI run failed `gmp-core/test/lan-discovery-test.js` on Node 20 and
22. That test skips on hosts that filter multicast, which includes the machine
it was developed on, so this was its first real run. GitHub's runners allow
multicast.

The fault was in the product, not the test. `LanDiscovery` received beacons,
but nothing consumed them:

- `GMPNodeManager.resolveGhostAddress` only searched links and the routing
  table.
- `connectByNodeId` only tried a mesh relay.

So in the no-infrastructure case the feature exists for (two devices on the
same network, no public peer), a Ghost Address could never resolve. The fix is
in `gmp-core/src/gmp-node-manager.ts`:

- **Resolve:** peers currently beaconing on the LAN count as known, so their
  addresses resolve. Nothing connects automatically: the test's "discovery
  does NOT connect anyone" privacy checks still pass.
- **Connect:** if the NodeID was seen on the LAN, dial the beacon's
  address:port directly, with a 5 s timeout. Beacons are unauthenticated, so
  the link is kept only if the Ed25519-authenticated handshake yields exactly
  the requested NodeID. Otherwise the link is destroyed, a
  `lan-identity-mismatch` warning is logged, and the code falls back to the
  mesh as before.

A new test section `[4b]` plants a beacon that claims an unrelated NodeID but
points at a real peer. It asserts that no LAN session results and that the
stray link is dropped. A mutation check (removing the `link.destroy()`) makes
it fail.

The test was reproduced locally in a private network namespace with a
multicast route on loopback:

```bash
unshare -rn sh -c 'ip link set lo up && ip route add 224.0.0.0/4 dev lo && \
  NODE_ENV=test node gmp-core/test/lan-discovery-test.js'
```

Unfixed code: 8/12, the same 4 failures as CI. Fixed: 12/12.

### 12. Hardcoded developer path in a mobile test — FIXED

`mobile/test/ghost-address.test.mjs` imported gmp-core from
`/home/shadow/Documents/Ghostlink/...`. Local "fresh clone" checks passed
because they ran on the machine where that path exists. CI failed with
`ERR_MODULE_NOT_FOUND`. The test now resolves the repo root from
`import.meta.url`.

To rule out any other machine-specific dependency, the full CI sequence was
re-run from a clone with the original checkout hidden by a tmpfs mount
(`unshare -rm`). All three suites pass that way, and the unfixed test fails
with the same error CI showed. `git grep /home/` finds no other hardcoded
paths in code. The dead `file:///home/...` links in the docs (`gmp-core/PROTOCOL_SPEC.md`,
`gmp-core/test/MANUAL_NAT_TEST.md` and others) now point at relative paths.

### 13. Claim-checkpoint timing test measured the wrong thing — FIXED

`claim-checkpoint-test.js` Test 7 failed on the Node 20 runner with
`worst 95.7 ms` against a 50 ms bound. Its loop made 60,000 claims without ever
yielding. A deferred checkpoint cannot run in that situation, so by design
(`CHECKPOINT_CEILING_RECORDS`) the claim log wrote one inline at claim 50,000.
The test was therefore timing the checkpoint write itself: under 50 ms on a
fast machine, over it on a busy runner.

The test now yields every 500 claims, the way a node handling handshakes does.
It also checks the property structurally: it stats the checkpoint file around
every `claimSessionKey()` call and asserts that no single call changed it.
Timing alone could not catch an inline write on a fast machine; a mutation that
forces inline checkpoints (37 ms, under the bound) passed the old check.
It now fails with "expected 0, got 2". On the real code the worst claim is
7–12 ms. The claim-log code is unchanged.

**Follow-up (2026-09-28):** the remaining timing bound (worst claim < 50 ms)
still failed once on a Node 24 runner, at 70.4 ms. The structural check passed
in the same run, so it was runner noise. A bound on the single slowest of
60,000 calls measures the machine, not the code, so it now asserts the 99.9th
percentile is under 20 ms. With every CPU core busy locally, p99.9 stayed
between 2.2 and 3.4 ms while the worst single call reached 31 ms. The
inline-write mutation still fails the test.

## How to apply and verify

From a clean checkout of this branch:

```bash
rm -rf node_modules gmp-core/node_modules gmp-core/dist
npm ci
npm test                  # pretest installs + builds gmp-core, then the web suite
npm run test:gmp          # 33 suites via run-all.mjs (lan-discovery SKIPs without multicast; see finding 11 to run it anyway)
npm run test:mobile
npm run build && git diff --exit-code app.bundle.js   # bundle in sync
(cd electron && npm run build:dir)                    # packaging check
git add SECURITY.md CONTRIBUTING.md CHANGELOG.md docs/PRODUCTION_READINESS.md  # no -f needed
```

Or run everything in CI order with `npm run ci`.

Results of this sequence on a fresh `git clone` with these changes applied
(Node 26.7, npm 11):

- `npm ci` and `npm test`: exit 0.
- gmp-core: 33 suites, 474 assertions, 0 failing.
- Mobile: all pass.
- `app.bundle.js` diff: empty.
- The same suites later passed on Node 22.23 and 24.21 (see finding 7).

Repository settings, done 2026-09-27: **private vulnerability reporting** is
enabled, because `SECURITY.md` points to it. Branch protection on `main`
requires the `Test (Node 22)`, `Test (Node 24)` and
`Desktop packaging sanity (linux --dir)` checks.

## Remaining work

### Android release signing

The repository contains only `mobile/android/app/debug.keystore`. That is
correct: the release keystore and its password must never be committed, and
`.gitignore` blocks both. The release keystore (`ghostlink-release.keystore`
plus `android/keystore.properties`) currently exists only on the maintainer's
workstation. `mobile/android/KEYSTORE.md` describes it and its certificate
fingerprint.

Release process:

1. **One-time:** if no upload keystore exists yet, create it with the
   `keytool -genkeypair` command in `KEYSTORE.md` (PKCS12, RSA 4096, alias
   `ghostlink`). Write `mobile/android/keystore.properties` with `storeFile`,
   `storePassword`, `keyAlias` and `keyPassword`.
2. **Back up both files offline, in two places.** Losing them means the app
   can never be updated. For Play distribution, enrol in Play App Signing so
   Google holds the app-signing key and this keystore becomes a resettable
   upload key.
3. Bump `versionCode` / `versionName` in `mobile/android/app/build.gradle`.
4. Run `cd mobile/android && ./gradlew assembleRelease` (or `bundleRelease`
   for Play). If `keystore.properties` is missing or incomplete, the build
   refuses with "Release build refused". It never silently falls back to the
   debug key.
5. Check the signature with `apksigner verify --print-certs`. The certificate
   must be `CN=GhostLink` with the SHA-256 recorded in `KEYSTORE.md`. Never
   ship `CN=Android Debug`.
6. **Optional, for CI signing later:** store the keystore base64-encoded in a
   GitHub Actions secret, together with the passwords. Decode it into
   `android/app/` inside the job and write `keystore.properties` from secrets.
   Restrict the job to a protected `release` environment that requires
   approval.

### `npm audit`

**Triaged 2026-09-27.** gmp-core has 0 advisories. The root tree went from 28
advisories (1 critical, 14 high) to **16 (0 critical, 6 high, 10 moderate)**
through non-breaking updates only. Those included `electron-updater`, which
ships in the desktop app, and the critical `shell-quote`. The run used
`npm audit fix --legacy-peer-deps`, because the tree already carries a peer
conflict (`react-native-gesture-handler` 2.14.1 against React Native 0.73.4).
The resulting lockfile installs with a plain `npm ci` on both npm 10 and 11.

All 16 remaining advisories need a breaking upgrade:

| Advisories | Needs | Ships to users? |
|---|---|---|
| `@react-native-community/cli*`, `ip`, `image-size`, `fast-xml-parser` (and `react-native` itself, flagged through them) | React Native 0.73 → 0.87 | **No.** Dev-server and build tooling (Metro, the CLI). Not in the APK. |
| `@react-navigation/*`, `query-string`, `decode-uri-component` | React Navigation 6 → 7 | **Yes, in the Android app.** Moderate, denial-of-service class (malformed URI decoding). They are reached through navigation's deep-link parsing. |

To finish:

1. Plan the React Navigation 7 migration: an API change across the mobile
   screens, then device testing.
2. Plan a React Native upgrade: large, with native Gradle and iOS changes.
3. Remove the `|| echo "::warning::…"` fallbacks from the audit steps once
   the remainder is fixed.
4. Add Dependabot (`.github/dependabot.yml`) for `npm` (root and
   `/gmp-core`) and `github-actions`.

### Versioning policy

- One version for the whole product. The root, `electron/`, `mobile/` and
  `gmp-core/` `package.json` files always carry the same SemVer version, and
  the release workflow enforces it for tagged builds.
- On each release, in one commit:
  1. Bump all four versions.
  2. Bump the Android `versionName` to match, and `versionCode` by one
     (monotonic, never reused).
  3. Move `[Unreleased]` in `CHANGELOG.md` to a dated version heading.
  4. Tag `X.Y.Z` on `main` (no `v` prefix, matching `0.0.0`–`0.0.3`). The
     release workflow accepts both forms.
- MAJOR: incompatible changes to the wire protocol, identity/recovery-phrase
  format, or stored-data format. MINOR: features. PATCH: fixes. Security fixes
  get a PATCH release even when nothing else is ready.

### Electron packaged build, end to end on all three OSes

Only Linux `--dir` and the Linux AppImage have been built and inspected. None
has been launched. Before the first signed release, do this on Windows, macOS
and Linux:

1. Install the artifact from `release.yml`.
2. Launch it, create an identity, and confirm the UI loads with no CSP
   violations in DevTools.
3. Confirm the mesh node starts (bridge on `127.0.0.1:3002`) and completes a
   handshake with a second node. Finding 10 would show here; it is fixed
   and probe-tested, but not yet exercised in an installed build.
4. Confirm state is written under the per-user data dir, not the install dir.
5. Open a `ghostlink://` deep link.
6. Quit and relaunch, and confirm the identity persists.

Also:

- **Code signing:** Windows Authenticode and Apple Developer ID plus
  notarization. After that, enable the publish step in `release.yml`.
  `electron-updater` is a dependency, so auto-update must not be switched on
  for unsigned builds.
- Consider an automated smoke test: launch under `xvfb-run` in CI, wait for the
  window to load, and assert that the bridge port answers.
