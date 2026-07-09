// Thin wrapper over the Web Speech API with live (interim) transcription.
// The panel's whole voice workflow is built on this: tap → speak → see words
// appear live → edit → send.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechSupported = !!SR;

// Create a dictation session. `onText(fullText)` fires continuously with the
// best-so-far transcript; `onEnd()` fires when recognition stops.
export function dictate({ base = '', onText, onEnd, onError } = {}) {
  if (!SR) return null;
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = true;

  let finalText = base ? base.trimEnd() + ' ' : '';

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onText && onText((finalText + interim).replace(/\s+/g, ' ').trimStart());
  };
  rec.onerror = (ev) => onError && onError(ev);
  rec.onend = () => onEnd && onEnd();

  try {
    rec.start();
  } catch {
    return null;
  }
  return {
    stop() {
      try {
        rec.stop();
      } catch {}
    },
  };
}
