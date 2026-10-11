/**
 * Read-only claim-log check, run at startup by unattended entry points before
 * the node can compact the log. A fingerprint recorded twice can only come
 * from two concurrent lock holders.
 *
 * Strictly read-only: nothing is locked, written, renamed or removed, and
 * nothing from gmp-core that could do so is imported. Output carries counts
 * and fingerprint prefixes, never the seed or a key.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const AAD = Buffer.from('gmp-nonce-claim-v1');
const IV = 12;
const TAG = 16;
const MAX = 64 * 1024;

export interface ClaimLogFileReport {
  file: string;
  bytes: number;
  records: number;
  distinct: number;
  /** Fingerprint prefixes recorded more than once, with how often and when. */
  duplicates: { prefix: string; count: number; at: string[] }[];
  /** Byte offset where reading stopped (unreadable or truncated from there), or null. */
  stoppedAt: number | null;
}

export interface ClaimLogReport {
  dataDir: string;
  verdict: 'no-claim-log' | 'clean' | 'duplicates';
  files: ClaimLogFileReport[];
  /** Logs sealed under another identity's key (skipped, not ours to judge). */
  otherIdentity: number;
  bootCounter: string | null;
}

function openRecord(key: Buffer, body: Buffer): { f: string; t: number } | null {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, IV));
    d.setAAD(AAD);
    d.setAuthTag(body.subarray(IV, IV + TAG));
    const p = JSON.parse(Buffer.concat([d.update(body.subarray(IV + TAG)), d.final()]).toString('utf8'));
    return p && typeof p.f === 'string' ? { f: p.f, t: Number(p.t) || 0 } : null;
  } catch {
    return null;
  }
}

function scan(key: Buffer, file: string): ClaimLogFileReport & { ours: boolean } {
  const buf = fs.readFileSync(file);
  const seen = new Map<string, number[]>();
  let off = 0;
  let records = 0;
  let stoppedAt: number | null = null;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len < IV + TAG || len > MAX || off + 4 + len > buf.length) { stoppedAt = off; break; }
    const rec = openRecord(key, buf.subarray(off + 4, off + 4 + len));
    if (!rec) { stoppedAt = off; break; }
    records++;
    const list = seen.get(rec.f) ?? [];
    list.push(rec.t);
    seen.set(rec.f, list);
    off += 4 + len;
  }
  if (stoppedAt === null && off < buf.length) stoppedAt = off;
  return {
    file,
    bytes: buf.length,
    records,
    distinct: seen.size,
    duplicates: [...seen].filter(([, ts]) => ts.length > 1).slice(0, 20)
      .map(([f, ts]) => ({ prefix: f.slice(0, 12), count: ts.length, at: ts.map((t) => new Date(t).toISOString()) })),
    stoppedAt,
    ours: records > 0 || stoppedAt !== 0,
  };
}

function findClaimLogs(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findClaimLogs(p, out);
    else if (/claims.*\.log$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Inspect every claim log under `dataDir` sealed under this seed's key. Read-only. */
export function inspectClaimLogs(dataDir: string, seedPhrase: string): ClaimLogReport {
  // Same derivation as nonce-store.ts deriveNonceStoreKey.
  const key = crypto.pbkdf2Sync(seedPhrase, 'ghostlink-nonce-store-v1', 100000, 32, 'sha256');
  const files: ClaimLogFileReport[] = [];
  let otherIdentity = 0;
  for (const file of findClaimLogs(dataDir)) {
    const r = scan(key, file);
    if (!r.ours) { otherIdentity++; continue; }
    const { ours: _ours, ...report } = r;
    files.push({ ...report, file: path.relative(dataDir, file) });
  }
  let bootCounter: string | null = null;
  try { bootCounter = fs.readFileSync(path.join(dataDir, 'boot-counter'), 'utf8').trim(); } catch { /* none yet */ }
  const verdict = files.length === 0 ? 'no-claim-log' : files.some((f) => f.duplicates.length) ? 'duplicates' : 'clean';
  return { dataDir, verdict, files, otherIdentity, bootCounter };
}

/** One human-readable line for the log. */
export function describeClaimLogReport(r: ClaimLogReport): string {
  const head = r.verdict === 'duplicates'
    ? 'DUPLICATE CLAIMS FOUND (written before the GM-M4-1 lock fix: two processes accepted one session key)'
    : r.verdict === 'clean' ? 'no duplicate claims' : 'no claim log for this identity yet';
  const files = r.files.map((f) => `${f.file}: ${f.records} records, ${f.distinct} distinct, ${f.duplicates.length} duplicated${f.stoppedAt !== null ? `, unreadable from byte ${f.stoppedAt}` : ''}`);
  return `claim-log check (read-only): ${head}` + (files.length ? ` — ${files.join('; ')}` : '')
    + `; boot counter ${r.bootCounter ?? 'none'}` + (r.otherIdentity ? `; ${r.otherIdentity} log(s) of another identity skipped` : '');
}

/** Run the check at startup and log its verdict. Never throws. */
export async function logStartupClaimLogCheck(entry: string, seedPhrase: string | undefined): Promise<ClaimLogReport | null> {
  const { default: logger } = await import('./logger.js');
  if (!seedPhrase) {
    logger.info(entry, 'claim-log-check', 'claim-log check (read-only): skipped — no GMP_SEED_PHRASE, so no key to read the log with');
    return null;
  }
  try {
    const { DATA_DIR } = await import('./paths.js');
    const report = inspectClaimLogs(DATA_DIR, seedPhrase);
    const log = report.verdict === 'duplicates' ? logger.error.bind(logger) : logger.info.bind(logger);
    log(entry, 'claim-log-check', describeClaimLogReport(report), {
      verdict: report.verdict,
      files: report.files.length,
      duplicated: report.files.reduce((n, f) => n + f.duplicates.length, 0),
      bootCounter: report.bootCounter,
    });
    return report;
  } catch (e) {
    console.error(`claim-log check could not run (the node starts anyway): ${(e as Error).message}`);
    return null;
  }
}
