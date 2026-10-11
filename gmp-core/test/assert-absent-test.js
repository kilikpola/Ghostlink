/**
 * The absence helper itself (M6-1c-fix-6e): an absence cannot be asserted
 * without a control, and a control that observes nothing fails it.
 *
 * Run: node test/assert-absent-test.js
 */
import { absenceAsserter } from './helpers/assert-absent.mjs';

let run = 0, passed = 0, failed = 0;
const assert = (c, m) => { run++; c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.error(`  ✗ ${m}`)); };

/** A suite's assert, recorded instead of counted. */
function recorder() {
  const calls = [];
  return { calls, ...absenceAsserter((c, m) => calls.push({ ok: !!c, m })) };
}
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log('\n=== 1. no form of the call without a control ===');
{
  const r = recorder();
  const noControl = throws(() => r.assertAbsent({ channel: 'x', absent: () => true, message: 'm' }));
  assert(noControl instanceof TypeError && /control thunk is REQUIRED/.test(noControl.message), `missing control throws (${noControl && noControl.message})`);
  const valueControl = throws(() => r.assertAbsent({ channel: 'x', control: true, absent: () => true, message: 'm' }));
  assert(valueControl instanceof TypeError, 'a control that is a value, not a thunk, throws');
  assert(throws(() => r.assertAbsent({ control: () => true, absent: () => true, message: 'm' })) instanceof TypeError, 'missing channel throws');
  assert(r.calls.length === 0, 'and nothing was reported as passed');
}

console.log('\n=== 2. a control that observes nothing makes the absence VACUOUS ===');
for (const nothing of [false, 0, [], new Set(), '', null, undefined]) {
  const r = recorder();
  const result = r.assertAbsent({ channel: 'dead channel', control: () => nothing, absent: () => true, message: 'nothing happened' });
  assert(result === false && r.calls.length === 2 && r.calls.every((c) => !c.ok) && /VACUOUS/.test(r.calls[1].m),
    `control returning ${JSON.stringify(nothing instanceof Set ? 'Set(0)' : nothing)}: both lines fail, the second says VACUOUS`);
}

console.log('\n=== 3. a live control lets the absence speak ===');
{
  const r = recorder();
  assert(r.assertAbsent({ channel: 'c', control: () => 3, absent: () => true, message: 'absent' }) === true && r.calls.every((c) => c.ok), 'observed + absent: passes');
  const r2 = recorder();
  assert(r2.assertAbsent({ channel: 'c', control: () => [1], absent: () => false, message: 'absent' }) === false && r2.calls[0].ok && !r2.calls[1].ok, 'observed + present: the absence fails');
  const r3 = recorder();
  const order = [];
  r3.assertAbsent({ channel: 'c', control: () => { order.push('control'); return true; }, absent: () => { order.push('absent'); return true; }, message: 'm' });
  assert(order.join() === 'control,absent', 'the control runs first');
}

console.log('\n=== 4. async ===');
{
  const r = recorder();
  assert(throws(() => r.assertAbsent({ channel: 'c', control: async () => true, absent: () => true, message: 'm' })) instanceof TypeError, 'an async control in the sync form throws');
  const ok = await r.assertAbsentAsync({ channel: 'c', control: async () => new Set([1]), absent: async () => true, message: 'm' });
  const vac = await r.assertAbsentAsync({ channel: 'c', control: async () => 0, absent: async () => true, message: 'm' });
  assert(ok === true && vac === false, 'assertAbsentAsync: observed passes, nothing observed is vacuous');
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${run} total`);
process.exit(failed ? 1 : 0);
