/**
 * RC1 manual test 4.6 — headless fixture identities that COLLIDE on their
 * 45-bit Ghost Address (both GHOST-A4F-0Y6-YA8) but have different full NodeIDs.
 * Built from DERIVED SEEDS (never a phrase); no seed bytes are ever printed.
 *
 *   node scripts/rc1-collision-node.mjs          # bootstraps via the shipped
 *                                                # public peer and stays up
 *   node scripts/rc1-collision-node.mjs --once   # start, print identity, stop
 *                                                # (local verification only)
 */
import { createGMPNode } from '../gmp-core/dist/node-factory.js';
import { ghostAddressFromNodeId } from '../gmp-core/dist/ghost-address.js';
import { hkdf } from '../gmp-core/node_modules/@noble/hashes/esm/hkdf.js';
import { sha512 } from '../gmp-core/node_modules/@noble/hashes/esm/sha512.js';

const FIXTURE = [969102, 4102598];
const once = process.argv.includes('--once');

// seed(index) = HKDF-SHA512(u64le(index), salt=none, info="gmp-collision-fixture-v1", 32)
function seedForIndex(i) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(i));
  return hkdf(sha512, b, undefined, 'gmp-collision-fixture-v1', 32);
}

const nodes = [];
for (const i of FIXTURE) {
  const node = createGMPNode({ derivedSeed: seedForIndex(i), port: 0, disableBootstrap: once });
  node.loadIdentityFromDerivedSeed();
  await node.listen();
  nodes.push(node);
  console.log(`index ${i}: GhostAddress ${ghostAddressFromNodeId(node.identity.nodeId)}  NodeID ${node.identity.nodeIdHex}  port ${node.port}`);
}
const [a, b] = nodes;
console.log(`same Ghost Address: ${ghostAddressFromNodeId(a.identity.nodeId) === ghostAddressFromNodeId(b.identity.nodeId)}`);
console.log(`different full NodeIDs: ${a.identity.nodeIdHex !== b.identity.nodeIdHex}`);

if (once) {
  for (const n of nodes) { try { n.close?.(); } catch (_) { /* ignore */ } }
  process.exit(0);
}
console.log('Both identities are up and bootstrapping via the public peer. Ctrl-C to stop.');
process.on('SIGINT', () => { for (const n of nodes) { try { n.close?.(); } catch (_) {} } process.exit(0); });
