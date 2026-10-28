/**
 * Behavioural differential: src/ratchet/ratchet.ts against
 * @signalapp/libsignal-client (identity-v2.md §7 test 2, D7; task R4).
 *
 * libsignal is AGPL-3.0 and a gmp-core devDependency ONLY; this helper is the
 * only file that loads it, and ratchet-test.js §6 proves it never ships.
 *
 * Bytes are never compared (different KDF labels, wire format, PQXDH + SPQR on
 * libsignal's side). Both implementations run the SAME abstract schedule of
 * sends, deliveries in any order, losses, replays and tampered copies, and the
 * outcome of every event (sent / cannot-send, decrypted / rejected) is
 * compared. Where the two differ by design, the limit is MEASURED here with a
 * boundary probe, and every divergence in the random schedules must be
 * explained by a measured limit; anything else fails.
 */

/** End offset of protobuf field 4 (the embedded SignalMessage) in a serialized PreKeySignalMessage. */
function innerMacEnd(bytes) {
  const varint = (o) => { let v = 0, sh = 0, b; do { b = bytes[o++]; v += (b & 0x7f) * 2 ** sh; sh += 7; } while (b & 0x80); return [v, o]; };
  let o = 1;                                                            // version byte
  while (o < bytes.length) {
    const [tag, o1] = varint(o); const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) { o = varint(o1)[1]; continue; }
    if (wire !== 2) throw new Error(`unexpected protobuf wire type ${wire}`);
    const [len, o2] = varint(o1);
    if (field === 4) return o2 + len;
    o = o2 + len;
  }
  throw new Error('no SignalMessage field in the PreKey message');
}

export async function run(R, { pair, te, td, prng, flip }) {
  let S;
  try { S = await import('@signalapp/libsignal-client'); } catch (e) {
    return { skip: `@signalapp/libsignal-client cannot be loaded here (${e.code || 'error'}: ${String(e.message).split('\n')[0]})` };
  }
  const checks = [];
  const check = (ok, msg) => checks.push({ ok: !!ok, msg });

  // ── libsignal side: in-memory stores, Bob publishes a PQXDH bundle ───────
  class Sessions extends S.SessionStore {
    m = new Map();
    async saveSession(a, r) { this.m.set(a.toString(), r.serialize()); }
    async getSession(a) { const b = this.m.get(a.toString()); return b ? S.SessionRecord.deserialize(b) : null; }
    async getExistingSessions(as) { return as.map((a) => this.m.get(a.toString())).filter(Boolean).map((b) => S.SessionRecord.deserialize(b)); }
  }
  class Identities extends S.IdentityKeyStore {
    constructor(pair, reg) { super(); this.pair = pair; this.reg = reg; this.m = new Map(); }
    async getIdentityKey() { return this.pair.privateKey; }
    async getLocalRegistrationId() { return this.reg; }
    async saveIdentity(a, k) { this.m.set(a.toString(), k.serialize()); return S.IdentityChange.NewOrUnchanged; }
    async isTrustedIdentity() { return true; }
    async getIdentity(a) { const b = this.m.get(a.toString()); return b ? S.PublicKey.deserialize(b) : null; }
  }
  class PreKeys extends S.PreKeyStore {
    async savePreKey() {} async getPreKey() { throw new Error('no one-time prekeys'); } async removePreKey() {}
  }
  class SignedPreKeys extends S.SignedPreKeyStore {
    m = new Map();
    async saveSignedPreKey(id, r) { this.m.set(id, r); } async getSignedPreKey(id) { return this.m.get(id); }
  }
  class KyberPreKeys extends S.KyberPreKeyStore {
    m = new Map();
    async saveKyberPreKey(id, r) { this.m.set(id, r); } async getKyberPreKey(id) { return this.m.get(id); } async markKyberPreKeyUsed() {}
  }
  async function lsPair() {
    const party = (name, reg) => {
      const id = S.IdentityKeyPair.generate();
      return { addr: S.ProtocolAddress.new(name, 1), sessions: new Sessions(), ids: new Identities(id, reg), id,
        pre: new PreKeys(), spk: new SignedPreKeys(), kyber: new KyberPreKeys() };
    };
    const A = party('alice', 1), B = party('bob', 2);
    const spkPriv = S.PrivateKey.generate(), spkPub = spkPriv.getPublicKey();
    const spkSig = B.id.privateKey.sign(spkPub.serialize());
    await B.spk.saveSignedPreKey(1, S.SignedPreKeyRecord.new(1, Date.now(), spkPub, spkPriv, spkSig));
    const kem = S.KEMKeyPair.generate();
    const kemSig = B.id.privateKey.sign(kem.getPublicKey().serialize());
    await B.kyber.saveKyberPreKey(1, S.KyberPreKeyRecord.new(1, Date.now(), kem, kemSig));
    const bundle = S.PreKeyBundle.new(2, 1, null, null, 1, spkPub, spkSig, B.id.publicKey, 1, kem.getPublicKey(), kemSig);
    await S.processPreKeyBundle(bundle, B.addr, A.addr, A.sessions, A.ids);
    return { A, B };
  }

  /** One driver per implementation: send(from, text) and recv(to, msg). */
  function oursDriver(seed) {
    const p = pair(seed);
    const st = { A: p.alice, B: p.bob }, dep = { A: p.dA, B: p.dB };
    return {
      name: 'ours',
      async send(from, text) {
        try { const e = R.encrypt(st[from], te(text), dep[from]); st[from] = e.state; return { msg: e.message, chain: Buffer.from(e.message.subarray(18, 50)).toString('hex') }; } catch { return null; }
      },
      async recv(to, m) {
        const d = R.decrypt(st[to], m.msg, dep[to]);
        if (!d.ok) return { ok: false, reason: d.reason };
        st[to] = d.state; return { ok: true, text: td(d.plaintext) };
      },
      tamper: (m) => ({ ...m, msg: flip(m.msg, 60) }),
    };
  }
  async function signalDriver() {
    const P = await lsPair();
    const peer = { A: 'B', B: 'A' };
    return {
      name: 'libsignal',
      async send(from, text) {
        try {
          const c = await S.signalEncrypt(te(text), P[peer[from]].addr, P[from].addr, P[from].sessions, P[from].ids);
          return { type: c.type(), bytes: c.serialize() };
        } catch { return null; }
      },
      async recv(to, m) {
        const me = P[to], from = P[peer[to]];
        try {
          const pt = m.type === S.CiphertextMessageType.PreKey
            ? await S.signalDecryptPreKey(S.PreKeySignalMessage.deserialize(m.bytes), from.addr, me.addr, me.sessions, me.ids, me.pre, me.spk, me.kyber)
            : await S.signalDecrypt(S.SignalMessage.deserialize(m.bytes), from.addr, me.addr, me.sessions, me.ids);
          return { ok: true, text: td(pt) };
        } catch (e) { return { ok: false, reason: e.code !== undefined ? `code ${e.code}` : String(e.message).slice(0, 60) }; }
      },
      // Flip the last byte of the SignalMessage MAC (its final 8 bytes). In a PreKey
      // message the SignalMessage is protobuf field 4; its other fields are not
      // authenticated once a session exists, so a flip there is not a tamper test.
      tamper: (m) => ({ ...m, bytes: flip(m.bytes, m.type === S.CiphertextMessageType.PreKey ? innerMacEnd(m.bytes) - 1 : m.bytes.length - 1) }),
    };
  }

  /** Run an event list; outcome strings per event, plus our chain ids per message. */
  async function play(driver, events) {
    const msgs = [], outcomes = [];
    for (const ev of events) {
      if (ev.op === 'send') {
        const m = await driver.send(ev.from, ev.text);
        msgs[ev.k] = m ? { ...m, to: ev.from === 'A' ? 'B' : 'A', text: ev.text } : null;
        outcomes.push(m ? 'sent' : 'cannot-send');
      } else {
        const m = msgs[ev.k];
        if (!m) { outcomes.push('no-message'); continue; }
        const r = await driver.recv(m.to, ev.op === 'tamper' ? driver.tamper(m) : m);
        outcomes.push(r.ok ? (r.text === m.text ? 'ok' : 'WRONG-TEXT') : 'fail');
      }
    }
    return { outcomes, msgs };
  }
  const describe = (ev) => (ev.op === 'send' ? `send ${ev.from}#${ev.k}` : `${ev.op} #${ev.k}`);

  // ── boundary probe 1: MAX_SKIP ──────────────────────────────────────────
  const gapEvents = (gap) => {
    const ev = [];
    for (let k = 0; k <= gap; k++) ev.push({ op: 'send', from: 'A', k, text: `g${k}` });
    ev.push({ op: 'deliver', k: gap });
    return ev;
  };
  const probe = async (events, seed) => {
    const a = await play(oursDriver(seed), events), b = await play(await signalDriver(), events);
    return { ours: a.outcomes.at(-1), signal: b.outcomes.at(-1) };
  };
  const g1000 = await probe(gapEvents(R.MAX_SKIP), 'diff-gap-1000');
  const g1001 = await probe(gapEvents(R.MAX_SKIP + 1), 'diff-gap-1001');
  check(g1000.ours === 'ok' && g1000.signal === 'ok', `skip exactly MAX_SKIP (${R.MAX_SKIP}) on one chain: ours ${g1000.ours}, libsignal ${g1000.signal} — same`);
  check(g1001.ours === 'fail' && g1001.signal === 'ok',
    `skip MAX_SKIP+1: ours ${g1001.ours}, libsignal ${g1001.signal} — the one designed divergence on gaps (§4.4 caps at 1000; libsignal allows far more)`);

  // ── boundary probe 2: how many DH turns an old chain's skipped key survives ─
  const turnsEvents = (turns) => {
    let k = 0;
    const ev = [{ op: 'send', from: 'A', k: k++, text: 'old-0' }, { op: 'send', from: 'A', k: k++, text: 'old-1' }, { op: 'deliver', k: 1 }];
    let from = 'B';
    for (let t = 0; t < turns; t++) { const kk = k++; ev.push({ op: 'send', from, k: kk, text: `turn-${t}` }, { op: 'deliver', k: kk }); from = from === 'A' ? 'B' : 'A'; }
    ev.push({ op: 'deliver', k: 0 });                                    // Bob gets A's very first message last
    return ev;
  };
  const survival = [];
  for (let turns = 0; turns <= 12; turns++) survival.push({ turns, ...(await probe(turnsEvents(turns), `diff-turns-${turns}`)) });
  const oursAll = survival.every((s) => s.ours === 'ok');
  const signalLimit = survival.find((s) => s.signal !== 'ok');
  // Receiver chains newer than the old one at delivery time: turns alternate B, A, B, …; each A turn gives Bob one.
  const newerChains = (turns) => Math.floor(turns / 2);
  const LS_MAX_NEWER = signalLimit ? newerChains(signalLimit.turns) - 1 : Infinity;
  check(oursAll, `an old chain's skipped key, 0..12 DH turns later: ours decrypts every time (store bounded by count and TTL only)`);
  check(!!signalLimit && survival.filter((s) => s.turns < signalLimit.turns).every((s) => s.signal === 'ok') && survival.filter((s) => s.turns >= signalLimit.turns).every((s) => s.signal !== 'ok'),
    `libsignal drops it once the old chain has ${signalLimit ? newerChains(signalLimit.turns) : '?'} newer receiver chains (first failure at ${signalLimit ? signalLimit.turns : '?'} turns; measured, monotonic) — the designed divergence on chain age`);

  // ── random schedules ────────────────────────────────────────────────────
  const SCHEDULES = 24, STEPS = 160;
  let events = 0, agreed = 0, explained = 0, deliveries = 0, failsBoth = 0;
  const unexplained = [];
  for (let seed = 1; seed <= SCHEDULES; seed++) {
    const rnd = prng(1000 + seed);
    const ev = [];
    const inflight = [], delivered = [];
    let k = 0, bobHas = false;
    for (let step = 0; step < STEPS; step++) {
      const r = rnd();
      if (r < 0.22 || (r < 0.42 && bobHas)) { const from = r < 0.22 ? 'A' : 'B'; ev.push({ op: 'send', from, k, text: `${from}${k}` }); inflight.push({ k, to: from === 'A' ? 'B' : 'A' }); k++; continue; }
      if (!inflight.length) continue;
      const i = Math.floor(rnd() * inflight.length);
      const a = rnd();
      if (a < 0.07) { inflight.splice(i, 1); continue; }                              // lost
      if (a < 0.25) continue;                                                       // delayed
      if (a < 0.32) { ev.push({ op: 'tamper', k: inflight[i].k }); continue; }      // a tampered copy first
      const m = inflight.splice(i, 1)[0];
      ev.push({ op: 'deliver', k: m.k }); delivered.push(m.k);
      if (m.to === 'B') bobHas = true;
      if (rnd() < 0.12) ev.push({ op: 'replay', k: delivered[Math.floor(rnd() * delivered.length)] });
    }
    for (const m of inflight) ev.push({ op: 'deliver', k: m.k });
    const a = await play(oursDriver(`diff-${seed}`), ev);
    const b = await play(await signalDriver(), ev);
    // Chain age per delivery, from our side (header DHr): how many newer chains the receiver had accepted.
    const seen = { A: [], B: [] };
    ev.forEach((e, i) => {
      events++;
      const m = a.msgs[e.k];
      let age = 0;
      if (e.op !== 'send' && m) { const list = seen[m.to]; const at = list.indexOf(m.chain); age = at < 0 ? 0 : list.length - 1 - at; }
      if (e.op === 'deliver') deliveries++;
      if (a.outcomes[i] === b.outcomes[i]) { agreed++; if (e.op === 'deliver' && a.outcomes[i] === 'fail') failsBoth++; }
      else if (e.op === 'deliver' && a.outcomes[i] === 'ok' && b.outcomes[i] === 'fail' && age > LS_MAX_NEWER) explained++;
      else unexplained.push(`seed ${seed} event ${i} (${describe(e)}, chain age ${age}): ours ${a.outcomes[i]}, libsignal ${b.outcomes[i]}`);
      if (e.op === 'deliver' && m && a.outcomes[i] === 'ok' && !seen[m.to].includes(m.chain)) seen[m.to].push(m.chain);
    });
  }
  check(unexplained.length === 0, `${SCHEDULES} schedules, ${events} events (${deliveries} deliveries): ${agreed} same outcome, ${explained} explained by the measured chain-age limit, ${unexplained.length} unexplained${unexplained.length ? ': ' + unexplained.slice(0, 3).join('; ') : ''}`);
  check(agreed > events * 0.9 && failsBoth === 0, `control: the schedules mostly agree (${agreed}/${events}) and no genuine delivery fails on both sides (${failsBoth})`);
  // Positive control for the comparator: a driver that rejects every replay-free delivery is caught.
  {
    const ev = [{ op: 'send', from: 'A', k: 0, text: 'x' }, { op: 'deliver', k: 0 }, { op: 'replay', k: 0 }, { op: 'tamper', k: 0 }];
    const a = await play(oursDriver('diff-control'), ev);
    const b = await play(await signalDriver(), ev);
    const broken = await play({ ...oursDriver('diff-control-2'), recv: async () => ({ ok: true, text: 'x' }) }, ev);
    check(a.outcomes.join() === 'sent,ok,fail,fail' && b.outcomes.join() === a.outcomes.join(), `deliver / replay / tamper: both give ${a.outcomes.join(', ')}`);
    check(broken.outcomes.join() !== b.outcomes.join(), `comparator control: a driver that accepts replays and tampering differs (${broken.outcomes.join(', ')})`);
  }
  return { checks, notes: { g1000, g1001, survival, LS_MAX_NEWER } };
}
