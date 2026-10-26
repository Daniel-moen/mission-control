// Speaking a reply sentence by sentence (task 0447). Pure — no DOM, no store —
// so test/sentence-queue-test.mjs runs it in plain Node with fake audio.
//
// The pieces (spoken.js talkParts) are asked for up front, `lookahead` at a
// time: piece 1 at once, pieces 2…n while 1 plays (the Mac makes them in the
// order they're asked, each faster than it is said). They're played strictly
// in order, one at a time, each as soon as the one before ends — no overlap,
// no waiting for the whole reply. A piece with no audio (Mac offline, cap,
// slow) is read by `fallback` (the device voice) in its place.
// stop() ends it at once: the playing piece is cut, nothing more starts, and
// audio that arrives later is released.
//
//   fetchAudio(text, i) → Promise<url|null>   (never rejects)
//   play(url)           → Promise<boolean>    false = couldn't start
//   fallback(text)      → Promise<boolean>    false = couldn't speak
//   release(url)        → frees a url never played
//   cut()               → stops the piece playing now (stop())
//   onEvent({type, i, at}) optional: 'request' | 'audio' | 'play' | 'fallback' | 'end' | 'stop'
export function createSentenceQueue({ parts, fetchAudio, play, fallback = async () => false, release = () => {}, cut = () => {}, lookahead = 3, onEvent = () => {}, now = () => Date.now() }) {
  const audio = [];
  const played = new Set();
  let stopped = false;
  const t0 = now();
  const timing = { parts: parts.length, firstAudioMs: null, totalMs: null, gapsMs: [] };
  const ev = (type, i) => onEvent({ type, i, at: now() - t0 });

  const want = (i) => {
    if (i >= parts.length || audio[i] || stopped) return audio[i];
    ev('request', i);
    audio[i] = Promise.resolve(fetchAudio(parts[i], i))
      .catch(() => null)
      .then((url) => {
        ev('audio', i);
        if (stopped && url) {
          release(url); // came back after a stop: nobody will play it
          return null;
        }
        return url;
      });
    return audio[i];
  };

  async function run() {
    let lastEnd = null;
    for (let i = 0; i < Math.min(lookahead, parts.length); i++) want(i);
    for (let i = 0; i < parts.length; i++) {
      want(i);
      const url = await audio[i];
      want(i + lookahead); // keep `lookahead` pieces asked for ahead of the one playing
      if (stopped) return false;
      const started = now() - t0;
      if (timing.firstAudioMs == null) timing.firstAudioMs = started;
      if (lastEnd != null) timing.gapsMs.push(started - lastEnd);
      let ok = false;
      if (url) {
        ev('play', i);
        played.add(i);
        ok = await play(url);
      }
      if (stopped) return false;
      if (!ok) {
        ev('fallback', i);
        await fallback(parts[i]);
        if (stopped) return false;
      }
      lastEnd = now() - t0;
    }
    timing.totalMs = now() - t0;
    ev('end', parts.length);
    return true;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    ev('stop', -1);
    cut();
    // Audio already back but never played (later arrivals release themselves).
    audio.forEach((p, i) => !played.has(i) && p?.then((u) => u && release(u)));
  }

  return { run, stop, timing, get stopped() { return stopped; } };
}
