#!/usr/bin/env node
/**
 * Read-only check of a node's claim log for double claims (the same check the
 * public and storage peers run at startup):
 *
 *   node gmp-core/scripts/check-claim-log.mjs [dataDir]
 *
 * GMP_SEED_PHRASE must be set. Prints counts and fingerprint prefixes, never keys.
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { inspectClaimLogs, describeClaimLogReport } = await import(pathToFileURL(path.join(here, '..', 'dist', 'claim-log-diagnostic.js')).href);

const seed = process.env.GMP_SEED_PHRASE;
if (!seed) {
  console.error('GMP_SEED_PHRASE is not set; the claim log is sealed under a key derived from it.');
  process.exit(2);
}
const dataDir = path.resolve(process.argv[2] || process.env.GMP_DATA_DIR || path.join(here, '..', 'data'));
const report = inspectClaimLogs(dataDir, seed);
console.log(`data dir: ${dataDir}`);
console.log(describeClaimLogReport(report));
for (const f of report.files) for (const d of f.duplicates) console.log(`  DUPLICATE ${d.prefix}… x${d.count} at ${d.at.join(', ')}`);
console.log(`RESULT: ${report.verdict}`);
process.exit(report.verdict === 'duplicates' ? 1 : 0);
