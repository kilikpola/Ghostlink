# Contributing to GhostLink

Thanks for helping. GhostLink is an encrypted messenger: a bug here can expose
someone's messages or identity, so the bar for review is higher than usual.
Please read the whole of this file before your first pull request, and the
[Security-sensitive changes](#security-sensitive-changes) section before every
one that touches crypto, transport, storage, or the app shells.

Security vulnerabilities are **not** reported through issues or PRs — see
[SECURITY.md](SECURITY.md).

## Repository layout

| Path | What | Build |
|------|------|-------|
| `index.html`, `src/`, `index-entry.js` | Web app | esbuild → committed `app.bundle.js` |
| `gmp-core/` | Ghost Mesh Protocol node + local bridge (TypeScript) | `tsc` → `gmp-core/dist/` (gitignored) |
| `electron/` | Desktop shell (loads the repo-root `index.html`) | electron-builder |
| `mobile/` | React Native app | Gradle / Xcode |
| `shared/` | Code shared by web and mobile (BIP-39 wordlist) | — |
| `test/` | Root (web) test suite | — |

`mobile` and `electron` are **npm workspaces** of the root package.
`gmp-core` is **not** — it has its own `package-lock.json` and is installed
separately (it must compile against its own `@types/node`, not the older copy
React Native hoists to the root).

## Setup

Requires **Node.js 22.12 or newer** (CI runs Node 22 and 24). Older versions
are end-of-life and unsupported: gmp-core uses the global `crypto` object, and
the tests rely on Node's ESM syntax detection.

```bash
git clone https://github.com/kilikpola/Ghostlink.git
cd Ghostlink
npm ci                  # root + mobile + electron workspaces
npm run install:gmp     # gmp-core's own dependencies
npm run build:gmp       # compile gmp-core → gmp-core/dist
```

**gmp-core must be built before anything that imports it** — the root tests,
the desktop app, and `npm start` all load `gmp-core/dist/`, which is not in
git. `npm test` does the install and build for you (via `pretest`); for
anything else, re-run `npm run build:gmp` after changing `gmp-core/src`.

To try an app:

```bash
python3 -m http.server 8000     # web — open http://localhost:8000
npm run desktop                 # Electron (after build:gmp)
npm run mobile:android          # React Native, needs the Android SDK
```

## Running the tests

| Command | Suite | Notes |
|---------|-------|-------|
| `npm test` | Root / web suite | Installs + builds gmp-core first (`pretest`). |
| `npm run test:web` | Root / web suite only | Assumes gmp-core is already built. |
| `npm run test:gmp` | gmp-core, via `gmp-core/test/run-all.mjs` | Runs every suite even if one fails; each gets a throwaway `GMP_DATA_DIR`. `lan-discovery-test.js` reports SKIP on hosts without multicast — that is expected, but it does run in CI. To run it locally anyway: `unshare -rn sh -c 'ip link set lo up && ip route add 224.0.0.0/4 dev lo && NODE_ENV=test node gmp-core/test/lan-discovery-test.js'` (Linux). |
| `npm run test:mobile` | Mobile (plain Node, no device needed) | |
| `npm run ci` | Everything CI runs, in CI's order | install:gmp → build:gmp → build → web → gmp → mobile |

All of it must pass before a PR is merged. CI runs the same commands on
Node 22 and 24 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), plus
an `electron-builder --dir` packaging check. The GitLab mirror runs the same
jobs from [`.gitlab-ci.yml`](.gitlab-ci.yml). Keep the two in step when you
change either. `main` is protected, so a PR
cannot merge until those checks pass. Run `npm run ci` locally first to catch
failures before you push.

## The committed web bundle

`app.bundle.js` is committed because GitHub Pages serves the static site
straight from the repository. It is **generated, never hand-edited**:

```bash
npm run build          # regenerates app.bundle.js from index-entry.js + src/
```

If your change touches `src/` or `index-entry.js`, run `npm run build` and
commit the regenerated bundle **in the same commit** as the source change.
CI rebuilds it and fails the job if `git diff app.bundle.js` is not empty.

## Pull requests

- Branch from `main`; name branches `fix/…`, `feat/…`, `chore/…`, `docs/…`,
  `security/…`.
- Keep one logical change per PR. A refactor and a behaviour change are two
  PRs.
- Commit messages: a short imperative subject with a conventional prefix —
  `fix:`, `feat:`, `security:`, `perf:`, `docs:`, `chore:`, `test:` (optionally
  scoped: `fix(mobile): …`). Say *why* in the body, especially for security
  fixes: what was wrong, what an attacker could do, how the change prevents it.
- Every bug fix comes with a test that fails without the fix.
- Add a line to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) for
  anything user-visible or security-relevant.
- Never delete, skip, or weaken an existing test to make a PR pass. If a test
  is genuinely wrong, fix it in its own commit and explain why in the message.
- Do not commit secrets, `.env` files, `*.pem`, keystores, or
  `keystore.properties` (all gitignored — don't force-add them).

## Security-sensitive changes

These need an issue or discussion **before** the PR, and review from a
maintainer who owns that area. Do not "fix" them in passing.

- **Never weaken the Content Security Policy** in `index.html` or
  `electron/src/main.js` — no `unsafe-eval`, no new `unsafe-inline`, no new
  remote origins. Fonts and JS are vendored under `vendor/`; keep it that way
  (no CDN calls).
- **Never weaken Electron's isolation**: `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true` stay as they are. New IPC channels
  in `preload.js` must validate their arguments and expose the narrowest
  possible API.
- **Cryptography**: no new primitives, custom constructions, or changes to key
  derivation, handshake, nonce/replay handling, or wire formats without a
  written rationale in the PR and matching tests. Fail closed: an error during
  key agreement or decryption must abort, never fall back to something weaker.
- **Random numbers** come from a CSPRNG (`crypto.getRandomValues`,
  `crypto.randomBytes`, `@noble/*`) — never `Math.random()`.
- **Untrusted input** (anything from a peer, a QR code, a deep link, the
  bridge WebSocket) is validated before use, and rendered text is escaped.
- **Dependencies**: justify every new runtime dependency in the PR. Prefer the
  audited `@noble/*` libraries already in use.
- Anything that makes a security property depend on the license tier is a bug
  (see [SECURITY.md](SECURITY.md)).

## License

GhostLink is GPL-3.0. By contributing you agree that your contributions are
licensed under the [GNU General Public License v3.0](LICENSE).
