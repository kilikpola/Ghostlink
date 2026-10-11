/**
 * Operator-actionable refusals under GMP_STRICT_STATE: each says what
 * happened, which file, the likely cause, the exact command, and what running
 * it gives up.
 */

import fs from 'fs';
import path from 'path';
import { StateAuthenticationError } from './types.js';

/**
 * Fixed-name state files sealed with a seed-derived key; a changed seed makes
 * them all unreadable. (The claim log is named after its key, so it is never
 * refused for this.)
 */
const SEED_SEALED_FIXED_NAMES = ['peer-cache.json', 'nonce-state.json', 'store-forward.state'];

/** Single-quote a path for a POSIX shell. */
function sh(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export interface Refusal {
  /** One line: what could not be trusted, and the underlying error. */
  what: string;
  file: string;
  /**
   * 'move-aside': the file cannot be trusted; moving it starts fresh.
   * 'fix-access': it may be intact but could not be read or written.
   */
  action: 'move-aside' | 'fix-access';
  /** What starting fresh gives up (move-aside). */
  loses?: string;
  /** Override the default likely-cause line. */
  cause?: string;
  /** A better route than moving the file, when there is one. */
  alternative?: string;
}

export function refusalMessage(r: Refusal, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const lines = [
    `Refusing to start (GMP_STRICT_STATE; on by default for public peer, relay and storage hosts).`,
    `What happened: ${r.what}`,
    `File: ${r.file}`,
  ];
  if (r.action === 'move-aside') {
    lines.push(
      `Likely cause: ${r.cause ?? 'GMP_SEED_PHRASE changed since this file was written (the file is sealed under a key derived from the seed), or the file was damaged or restored from elsewhere.'}`,
      `If the seed phrase did NOT change, do not move the file: restore the right seed, or keep the file for inspection.`,
      `To start this state fresh deliberately (nothing is deleted):`,
      `    mv ${sh(r.file)} ${sh(`${r.file}.refused-${stamp}`)}`,
      `What that gives up: ${r.loses ?? 'what this file recorded.'}`,
    );
    // A seed change hits every fixed-name sealed file at once; say so now
    // rather than refusing once per file across several restarts.
    if (!r.cause) {
      const dir = path.dirname(r.file);
      const siblings = SEED_SEALED_FIXED_NAMES
        .map((n) => path.join(dir, n))
        .filter((f) => f !== r.file && fs.existsSync(f));
      if (siblings.length) {
        lines.push(
          `If the seed phrase changed, these are sealed under the old seed too and would refuse next: ${siblings.map((f) => path.basename(f)).join(', ')}. To move them all at once:`,
          `    ${[r.file, ...siblings].map((f) => `mv ${sh(f)} ${sh(`${f}.refused-${stamp}`)}`).join(' && ')}`,
        );
      }
    }
    if (r.alternative) lines.push(`Better, if it applies: ${r.alternative}`);
  } else {
    lines.push(
      `Likely cause: ${r.cause ?? 'permissions, ownership, a read-only or full volume, or an I/O error.'}`,
      `Do not move or delete the file: it may be intact. Check it with:`,
      `    ls -l ${sh(r.file)}; df -h ${sh(r.file.replace(/\/[^/]*$/, '') || '/')}`,
      `then fix access and restart.`,
    );
  }
  return lines.join('\n');
}

export function refuse(r: Refusal): StateAuthenticationError {
  return new StateAuthenticationError(refusalMessage(r));
}
