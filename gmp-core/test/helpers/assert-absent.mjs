/**
 * Asserting that something did NOT happen — only with proof that it could
 * have been seen (M6-1c-fix-6e).
 *
 * "Never happened / no event / 0 of N" passes just as well when the channel
 * that would have shown it is dead. The sweep in M6-1c-fix-6d found 38 such
 * assertions without a positive control, three of them on dead or wrong
 * channels — one of which produced a figure that was published. A standing
 * rule did not stop them being written, and a regex could not find them all.
 * So the API makes them unwriteable instead, the way security controls became
 * non-optional (SessionKeyLRUSet, the rate limiter): there is no form of this
 * call without a control, and a control that observes nothing fails the
 * assertion rather than letting the absence pass.
 *
 *   const { assertAbsent, assertAbsentAsync } = absenceAsserter(assert);
 *   assertAbsent({
 *     channel: 'relay links',                       // what is being watched
 *     control: () => H.links has N's NodeID,         // REQUIRED: the channel seeing the thing
 *     absent:  () => !R.links has N's NodeID,        // the absence itself
 *     message: 'no link carrying N\'s real NodeID',
 *   });
 *
 * The control runs FIRST. It must return an observation: true, a positive
 * number, or a non-empty array / Set / Map / string. false, 0, empty, null or
 * undefined means the channel saw nothing: the absence is then reported as
 * VACUOUS (a failure), never as passing. Make `absent` self-contained (take
 * its own before/after readings) so a control with side effects cannot
 * disturb it.
 */

function observed(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length > 0;
  if (v instanceof Set || v instanceof Map) return v.size > 0;
  return false;
}

function describe(v) {
  if (v instanceof Set || v instanceof Map) return `${v.constructor.name}(${v.size})`;
  if (Array.isArray(v)) return `[${v.length}]`;
  return JSON.stringify(v);
}

function check(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('assertAbsent: pass { channel, control, absent, message }');
  const { channel, control, absent, message } = spec;
  if (typeof channel !== 'string' || !channel) throw new TypeError('assertAbsent: channel (what is watched) is required');
  if (typeof control !== 'function') throw new TypeError(`assertAbsent(${channel}): a control thunk is REQUIRED — an absence with no positive control is vacuous`);
  if (typeof absent !== 'function') throw new TypeError(`assertAbsent(${channel}): absent must be a thunk`);
  if (typeof message !== 'string' || !message) throw new TypeError(`assertAbsent(${channel}): message is required`);
  return spec;
}

function report(assert, { channel, message, controlMessage }, controlValue, absentValue) {
  const saw = observed(controlValue);
  assert(saw, `control [${channel}]: ${controlMessage || 'the channel observes the event'} (${describe(controlValue)})`);
  if (!saw) {
    assert(false, `${message} — VACUOUS: the control saw nothing on ${channel}, so this absence proves nothing`);
    return false;
  }
  assert(absentValue === true, message);
  return absentValue === true;
}

/** Bind to a suite's own assert(cond, message), so counts and summaries stay the suite's. */
export function absenceAsserter(assert) {
  return {
    assertAbsent(spec) {
      check(spec);
      const c = spec.control();
      if (c && typeof c.then === 'function') throw new TypeError(`assertAbsent(${spec.channel}): control is async — use assertAbsentAsync`);
      const a = spec.absent();
      if (a && typeof a.then === 'function') throw new TypeError(`assertAbsent(${spec.channel}): absent is async — use assertAbsentAsync`);
      return report(assert, spec, c, a);
    },
    async assertAbsentAsync(spec) {
      check(spec);
      const c = await spec.control();
      const a = await spec.absent();
      return report(assert, spec, c, a);
    },
  };
}
