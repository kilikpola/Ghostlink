// Resolve hook for the NullTransport proof: importing any of Node's socket modules throws.
const BLOCKED = new Set(['net', 'node:net', 'tls', 'node:tls', 'dgram', 'node:dgram']);
export async function resolve(specifier, context, next) {
  if (BLOCKED.has(specifier)) throw new Error(`BLOCKED import of '${specifier}' from ${context.parentURL}`);
  return next(specifier, context);
}
