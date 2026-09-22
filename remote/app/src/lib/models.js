// Model catalogue for every picker in the app.
//
// The host advertises the models the installed Mac app knows about; this list
// is what the panel can offer ON TOP of that — the host passes any flag
// straight to `claude --model`, so a newer model works even while the Mac app
// predates it.

export const KNOWN_MODELS = [
  { flag: 'claude-fable-5-1', label: 'Fable 5.1', short: 'Fable 5.1', blurb: 'Newest frontier model — sharpest of the line' },
  { flag: 'claude-fable-5', label: 'Fable 5', short: 'Fable', blurb: 'Frontier intelligence — the apex model' },
  { flag: 'claude-opus-5', label: 'Opus 5', short: 'Opus', blurb: 'Deepest reasoning — the heavy lifter' },
  { flag: 'claude-opus-4-8', label: 'Opus 4.8', short: 'Opus 4.8', blurb: 'Previous Opus — proven and steady' },
  { flag: 'claude-sonnet-5', label: 'Sonnet 5', short: 'Sonnet', blurb: 'Near-Opus smarts at Sonnet speed' },
  { flag: 'haiku', label: 'Haiku 4.5', short: 'Haiku', blurb: 'Fast & cheap — quick passes' },
  { flag: 'default', label: 'Default', short: 'Default', blurb: 'Whatever your CLI defaults to' },
];

// Host list first (it reflects the installed app), then any KNOWN model the
// host doesn't list, deduped by flag. So Fable 5.1 shows up even while the Mac
// app predates it.
export function mergeModels(hostModels) {
  const out = [];
  const seen = new Set();
  for (const m of hostModels || []) {
    if (!m || !m.flag || seen.has(m.flag)) continue;
    seen.add(m.flag);
    out.push(m);
  }
  for (const m of KNOWN_MODELS) {
    if (seen.has(m.flag)) continue;
    seen.add(m.flag);
    out.push(m);
  }
  return out;
}

// A flag's display label. Pass the host's list (or a merged one) to catch the
// models only the installed app knows about; an unknown flag prints itself
// rather than vanishing.
export function modelLabel(flag, list) {
  if (!flag) return '';
  const hit = (list || []).find((m) => m && m.flag === flag) || KNOWN_MODELS.find((m) => m.flag === flag);
  return hit ? hit.label || hit.flag : String(flag);
}

export const DEFAULT_SOLO = 'claude-fable-5-1';
export const DEFAULT_MANAGER = 'claude-fable-5-1';
export const DEFAULT_WORKER = 'claude-sonnet-5';
