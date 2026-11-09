// v6.4 backdrops: public/bg6 (rendered by tools/backdrops). The time of day
// picks the tone (dawn 5–8, day 8–17, dusk 17–20, night 20–5) and the date
// rotates through that tone's images; a pin ('city-night' or 'city-night.webp') wins.
export interface Backdrop { file: string; tone: string }

export function pickBackdrop(list: Backdrop[], d: Date, pin?: string | null): string {
  if (pin) {
    const p = list.find((b) => b.file === pin || b.file === `${pin}.webp`);
    if (p) return p.file;
  }
  const hr = d.getHours();
  const tone = hr >= 5 && hr < 8 ? 'dawn' : hr >= 8 && hr < 17 ? 'day' : hr >= 17 && hr < 20 ? 'dusk' : 'night';
  const pool = list.filter((b) => b.tone === tone);
  const day = Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
  return (pool.length ? pool : list)[day % (pool.length || list.length)].file;
}
