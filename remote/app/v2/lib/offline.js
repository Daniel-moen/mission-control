import { useMC } from '../../src/lib/store.js';

// Offline-tolerant start (task 0444). The last good picture of the fleet —
// agents (minus their terminal text), Library metadata and Mia's thread — is
// kept on this device, so a cold open on a train shows what was true a minute
// ago, clearly marked as old, instead of a blank "Connecting…". The first
// live snapshot replaces it wholesale (the store's ingest diffs against keys
// this never touches). Nothing here is ever sent anywhere.

const KEY = 'mc.v2.lastSeen';
const EVERY_MS = 15000;

export function hydrateFromCache() {
  if (useMC.getState().snapshot) return;
  let c = null;
  try {
    c = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return;
  }
  if (!c || !c.at || !Array.isArray(c.agents)) return;
  // Older than a day isn't "a moment ago" any more — not worth showing.
  if (Date.now() - c.at > 24 * 3600e3) return;
  useMC.setState({
    agents: c.agents,
    summary: c.summary || {},
    docs: c.docs || [],
    mia: c.mia || null,
    fleets: c.fleets || [],
  });
  useV2Cache.at = c.at;
}

// Read by the connection pill: when the cached picture was taken (0 = live).
export const useV2Cache = { at: 0 };

let lastSave = 0;
export function startCaching() {
  return useMC.subscribe((s, prev) => {
    if (s.lastSnapshotAt === prev.lastSnapshotAt || !s.snapshot) return;
    if (useV2Cache.at) {
      // The store only replaces docs / Mia when they change from what it last
      // ingested — an empty live Library or an absent Mia would leave the
      // cached ones standing. The first live snapshot settles that.
      useV2Cache.at = 0;
      const fix = {};
      if (!(s.snapshot.docs || []).length && s.docs.length) fix.docs = [];
      if (!s.snapshot.mia && s.mia) fix.mia = null;
      if (Object.keys(fix).length) useMC.setState(fix);
    }
    if (Date.now() - lastSave < EVERY_MS) return;
    lastSave = Date.now();
    const slim = (a) => {
      // eslint-disable-next-line no-unused-vars
      const { screen, log, ...rest } = a;
      return rest;
    };
    const out = {
      at: Date.now(),
      agents: s.agents.map(slim),
      summary: s.summary,
      docs: s.docs,
      fleets: s.fleets,
      mia: s.mia ? { ...s.mia, messages: s.mia.messages.slice(-80) } : null,
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* quota / private mode — the live view is unaffected */
    }
  });
}
