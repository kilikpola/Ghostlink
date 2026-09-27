# Security Policy — GhostLink

This file covers the GhostLink apps (web, desktop, mobile). The mesh transport
has its own policy in [`gmp-core/SECURITY.md`](gmp-core/SECURITY.md).

---

## Accepted limitations

### Licensing is an honesty mechanism, not a cryptographic control

Pro and Enterprise licenses are verified entirely on the user's device
(`src/license/license-core.js`). The verification key is an HMAC secret that
ships inside the client, lightly obfuscated, and the signature on a license key
is 40 bits. It follows that:

- anyone who reads the client can mint valid license keys offline;
- anyone can patch the check out of their own copy of the app.

This is not fixable while GhostLink keeps its zero-server design: a check that
runs only on the user's machine can always be bypassed by that user, and
verifying licenses against a server would contradict the "zero servers"
promise. We accept it deliberately.

What this means in practice:

- A license key tells you what someone paid for. It does not prevent use of
  paid features, and nothing in GhostLink's security relies on it.
- Paid tiers gate convenience features only. No encryption, key handling,
  or privacy protection depends on license state, and none ever should — a
  change that makes a security property depend on the license tier is a bug.
- License bugs that let a user unlock features on their own device are not
  treated as security vulnerabilities. Bugs where one user's license actions
  affect another user are.

What we did remove, because it made forging trivial rather than merely
possible: a `window.generateLicense` console helper that shipped in the
production bundle, and trust in the cached license tier and expiry stored in
`localStorage` (the stored key is now re-verified on every load).

---

## Disabled features

### Guardian (social) recovery

Splitting a recovery backup into fragments held by trusted contacts is
**disabled** on web and mobile. The receiving side never stored fragments, so
a backup could be reported as "safe" while no guardian actually held
anything. Until a transport exists that delivers, stores and returns fragments,
the feature is gated off on both the sending and receiving side, and the app
never reports a guardian backup as complete. Use the recovery phrase.

---

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security
problem.** Report it privately, by either:

- email to **ghostlink@proton.me**, or
- GitHub's private vulnerability reporting: *Security → Report a
  vulnerability* on <https://github.com/kilikpola/Ghostlink>.

Please include:

- the affected component (web, desktop, mobile, gmp-core) and version or
  commit hash;
- what an attacker needs (network position, a malicious peer, a malicious web
  page, local access…) and what they gain;
- steps to reproduce or a proof of concept — the smallest one that works.

### Scope

| Component | Location | In scope |
|-----------|----------|----------|
| Web app | `index.html`, `src/`, `app.bundle.js`, `vendor/` | Key handling, message/file encryption, XSS / CSP bypass, storage at rest, anything that weakens the P2P trust model |
| Desktop app | `electron/` | Sandbox / context-isolation escapes, IPC abuse from the renderer, deep-link (`ghostlink://`) handling, the embedded mesh node and its local bridge |
| Mobile app | `mobile/` | Key storage (Keychain / Keystore), recovery-phrase handling, QR / deep-link input, transport encryption |
| Mesh core | `gmp-core/` | Handshake, replay protection, routing/topology authentication, the loopback bridge. The protocol's own threat model and known limits are in [`gmp-core/SECURITY.md`](gmp-core/SECURITY.md) — read it first; issues it already lists as out of scope are not vulnerabilities |
| Build & release | `.github/workflows/`, package manifests | Anything that lets an outsider change what ships in a release |

Out of scope: the accepted limitations above (client-side licensing), disabled
features (guardian recovery), findings that require an already-compromised
device, denial of service needing more bandwidth than the target has, and
reports from automated scanners without a demonstrated impact.

### What happens next — 90-day disclosure

| When | What |
|------|------|
| within 3 working days | We acknowledge the report. |
| within 10 working days | We confirm or reject it and give a severity assessment. |
| as fast as severity requires | A fix is developed privately; you are kept informed and may review it. |
| **90 days after the report**, or on release of the fix if sooner | Coordinated public disclosure: a GitHub Security Advisory, a CHANGELOG entry, and credit to you unless you prefer to stay anonymous. |

If a fix needs longer than 90 days we will ask you, explain why, and agree on a
new date — we will not sit on a report silently. If a vulnerability is already
being exploited in the wild, we may disclose sooner with mitigations.

We do not run a paid bug bounty. We will not pursue legal action against
good-faith research that respects users' privacy, avoids accessing other
people's data or disrupting their service, and follows this process.

### Supported versions

Security fixes land on `main` and ship in the next release. Only the latest
release of each app (web, desktop, mobile) is supported.
