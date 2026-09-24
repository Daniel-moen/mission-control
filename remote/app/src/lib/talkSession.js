import { create } from 'zustand';
import { primeTalk } from './voice.js';

// The talk session, lifted out of the Mia view so it survives navigation.
//
// Talk (views/mia/Talk.jsx) is mounted ONCE, by TalkHost at the app root,
// for as long as a session is on. Where it shows is a matter of DOM, not of
// React: while the Mia window is open and holds a <TalkSlot/>, the host's
// node sits inside that slot and the full talk view is what you see; anywhere
// else the node is parked off-screen and TalkPill (top bar) stands in for it.
// The mic, the realtime call and the speech queue never notice the move.
//
// The engines publish what the pill needs: the phase, their level listeners
// and an orb-tap function. `context` is an announcement the session was opened
// to answer (lib/announce.js), so "yes" or "option two" lands on that question.

export const useTalk = create(() => ({
  on: false,
  phase: 'idle', // the engine's phase (TalkParts LABEL keys)
  engine: '', // 'basic' | 'realtime'
  levels: null, // Set<fn(level)> — the engine's mic level listeners
  tap: null, // the engine's orb tap
  slot: null, // DOM node of the Mia view's TalkSlot, when mounted
  context: null, // a Mia message the session was opened to answer
  expandN: 0, // bumps when the pill asks for the full view back
  pill: false, // TalkHost is showing its top-bar pill (the wake pill yields to it)
}));

const set = (p) => useTalk.setState(p);
export const getTalk = () => useTalk.getState();

// Must run inside the tap: primeTalk() does the gesture-bound audio work.
// `prime: false` for "Hey Mia", which lends the wake word's own mic instead
// (lib/wake.js) — a second getUserMedia would mute it on iOS.
export function startTalk({ context = null, prime = true } = {}) {
  if (getTalk().on) {
    if (context) set({ context });
    return;
  }
  if (prime) primeTalk();
  set({ on: true, phase: 'starting', context });
}

export function endTalk() {
  set({ on: false, phase: 'idle', engine: '', levels: null, tap: null, context: null });
}

export function talkPhase(phase) {
  if (getTalk().phase !== phase) set({ phase });
}

// An engine announces itself on mount; the returned cleanup forgets it again
// (unless another engine has already taken over).
export function registerEngine(engine, levels, tap) {
  set({ engine, levels, tap });
  return () => {
    if (getTalk().levels === levels) set({ levels: null, tap: null });
  };
}

export function requestExpand() {
  set({ expandN: getTalk().expandN + 1 });
}

export function setTalkSlot(el) {
  set({ slot: el });
}
