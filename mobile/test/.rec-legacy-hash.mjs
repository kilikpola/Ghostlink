/**
 * The "sha256" of GhostLink mobile 0.0.0-0.0.2, verbatim, used only to check a
 * phrase against the `gl_seed_check` value those builds stored. It is a
 * ~32-bit FNV-style hash, not SHA-256: never use it for anything new.
 */
export async function legacySha256(data) {
  const encoder = new TextEncoder();
  const msgBuffer = encoder.encode(data);
  let hash = 0x811c9dc5;
  const prime = 0x01000193;
  for (let i = 0; i < msgBuffer.length; i++) {
    hash ^= msgBuffer[i];
    hash = Math.imul(hash, prime);
  }
  let h1 = hash >>> 0;
  let h2 = (h1 * 0x5bd1e995) >>> 0;
  let h3 = (h2 * 0xcc9e2d51) >>> 0;
  let h4 = (h3 * 0x1b873593) >>> 0;
  const parts = [h1, h2, h3, h4, h1 ^ h2, h2 ^ h3, h3 ^ h4, h4 ^ h1];
  return parts.map(v => v.toString(16).padStart(8, '0')).join('');
}
