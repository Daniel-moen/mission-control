import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useMC, changeToken, forgetToken, dataAge, stopAll, PANEL_BUILD } from '../../lib/store.js';
import { useNow } from '../../lib/hooks.js';
import Sheet from '../../ui/Sheet.jsx';
import Button from '../../ui/Button.jsx';
import Icon from '../../ui/Icon.jsx';
import { spring } from '../../lib/motion.js';

// Settings — the device's own page: what it is connected to, the two ambient
// modes, the backdrop photograph, and how a bot gets the same access.
// Everything here is local to this browser; nothing is stored on the relay.

const LS_BACKDROP = 'mc.backdrop';

function readBackdrop() {
  try {
    return JSON.parse(localStorage.getItem(LS_BACKDROP) || 'null') || {};
  } catch {
    return {};
  }
}
// Backdrop.jsx listens for this event (and for `storage`, which only fires in
// OTHER tabs) — so the scene changes under the sheet as you tap a thumbnail.
function writeBackdrop(next) {
  try {
    if (next && (next.file || next.url || typeof next.dim === 'number')) {
      localStorage.setItem(LS_BACKDROP, JSON.stringify(next));
    } else {
      localStorage.removeItem(LS_BACKDROP);
    }
  } catch {
    /* private mode — this visit only */
  }
  window.dispatchEvent(new CustomEvent('mc:backdrop'));
}

function Section({ title, children }) {
  return (
    <section className="rounded-[18px] border border-glass-line bg-white/[0.04] p-4 sm:p-5">
      <div className="label mb-1.5">{title}</div>
      {children}
    </section>
  );
}

function Row({ label, hint, children, last = false }) {
  return (
    <div
      className={`flex min-h-[44px] items-center justify-between gap-4 py-3 ${
        last ? '' : 'border-b border-glass-line/60'
      }`}
    >
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium tracking-tight text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-ink3">{hint}</div>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

export default function Settings({ onClose }) {
  const token = useMC((s) => s.token);
  const link = useMC((s) => s.link);
  useNow(); // dataAge() reads the 1 Hz clock — subscribe so the row ticks
  const age = dataAge();

  const linkLabel = link === 'linked' ? 'Mac linked' : link === 'relay' ? 'Relay only' : 'Offline';
  const rows = [
    ['Relay', location.host],
    ['Mac host', linkLabel],
    ['Last snapshot', age === null ? 'never' : age <= 2 ? 'just now' : `${age}s ago`],
    ['Access token', token ? token.slice(0, 4) + '••••••••' : '—'],
    ['Panel build', PANEL_BUILD],
  ];

  // ---- backdrop ---------------------------------------------------------------
  const [photos, setPhotos] = useState([]);
  const [bd, setBd] = useState(readBackdrop);
  const [urlDraft, setUrlDraft] = useState(() => readBackdrop().url || '');
  const dimPct = Math.round((typeof bd.dim === 'number' ? bd.dim : 0.2) * 100);

  useEffect(() => {
    let dead = false;
    fetch('/bg/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (!dead && Array.isArray(list)) setPhotos(list.filter((e) => e && e.file));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);

  const apply = (patch) => {
    // `dim` survives every choice; picking a source clears the other one so the
    // override never says two contradictory things at once.
    const next = { ...bd, ...patch };
    if ('file' in patch && patch.file) delete next.url;
    if ('url' in patch && patch.url) delete next.file;
    if ('file' in patch && !patch.file) delete next.file;
    if ('url' in patch && !patch.url) delete next.url;
    setBd(next);
    writeBackdrop(next);
  };

  const credits = useMemo(() => photos.filter((p) => p.credit), [photos]);

  // ---- API access -------------------------------------------------------------
  const [copied, setCopied] = useState(false);
  const apiBase = `${location.origin}/api/v1`;
  // Setup snippet for a bot/agent machine (OpenClaw etc.) — outbound HTTPS only,
  // same token as this panel. Copied with the real token filled in.
  function copySetup() {
    const snippet = [
      `export MISSION_CONTROL_URL="${location.origin}"`,
      `export MISSION_CONTROL_TOKEN="${token}"`,
      `curl -sf -H "Authorization: Bearer $MISSION_CONTROL_TOKEN" "$MISSION_CONTROL_URL/api/v1/status"`,
    ].join('\n');
    navigator.clipboard?.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const openMode = (hash) => {
    location.hash = hash;
    onClose?.();
  };

  return (
    <Sheet open onClose={onClose} title="Settings" size="lg">
      <div className="flex flex-col gap-3.5 pb-1">
        <Section title="Connection">
          {rows.map(([k, v], i) => (
            <div
              key={k}
              className={`flex min-h-[42px] items-center justify-between gap-4 py-2.5 ${
                i === rows.length - 1 ? '' : 'border-b border-glass-line/60'
              }`}
            >
              <span className="text-[13px] text-ink3">{k}</span>
              <span className="tnum max-w-[58%] truncate font-mono text-[12.5px] text-ink">{v}</span>
            </div>
          ))}
        </Section>

        <Section title="Modes">
          <Row label="TV mode" hint="Ambient fleet display for a big screen — or open #tv directly">
            <Button icon="tv" onClick={() => openMode('#tv')}>
              Open
            </Button>
          </Row>
          <Row label="Car mode" hint="Voice-first driving view: asks read aloud, giant buttons — or open #car" last>
            <Button icon="car" onClick={() => openMode('#car')}>
              Open
            </Button>
          </Row>
        </Section>

        <Section title="Backdrop">
          <p className="pb-3 pt-1 text-[12.5px] leading-relaxed text-ink3">
            The photograph behind everything. Auto follows the time of day; pick one to pin it.
          </p>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {/* Auto is a tile like any other — it just has no photo. */}
            <motion.button
              whileTap={{ scale: 0.97 }}
              transition={spring.snappy}
              onClick={() => apply({ file: '', url: '' })}
              className={`grid aspect-[4/3] place-items-center rounded-xl2 border text-[12px] font-medium transition-colors ${
                !bd.file && !bd.url
                  ? 'border-accent/60 bg-accent/12 text-accent'
                  : 'border-glass-line bg-white/[0.05] text-ink2 hover:border-glass-line2'
              }`}
            >
              <span className="flex flex-col items-center gap-1.5">
                <Icon name="clock" size={18} />
                Auto
              </span>
            </motion.button>

            {photos.map((p) => {
              const on = bd.file === p.file && !bd.url;
              return (
                <motion.button
                  key={p.file}
                  whileTap={{ scale: 0.97 }}
                  transition={spring.snappy}
                  onClick={() => apply({ file: p.file })}
                  title={p.credit || p.file}
                  className={`relative aspect-[4/3] overflow-hidden rounded-xl2 border transition-colors ${
                    on ? 'border-accent/70' : 'border-glass-line hover:border-glass-line2'
                  }`}
                >
                  <img src={`/bg/${p.file}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                  {on && (
                    <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-accent text-accent-ink">
                      <Icon name="check" size={13} strokeWidth={2.4} />
                    </span>
                  )}
                  {p.credit && (
                    <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] text-white/75">
                      {p.credit}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>

          {!photos.length && (
            <div className="mt-2.5 text-[12px] text-ink3">
              No bundled photos on this build — Auto falls back to the graphite gradient.
            </div>
          )}

          {credits.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] leading-snug text-ink3">
              <span className="text-ink3/70">Photos by</span>
              {credits.map((p) =>
                p.link ? (
                  <a
                    key={p.file}
                    href={p.link}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline decoration-ink3/40 underline-offset-2 transition-colors hover:text-ink2"
                  >
                    {p.credit}
                  </a>
                ) : (
                  <span key={p.file}>{p.credit}</span>
                ),
              )}
            </div>
          )}

          <label className="mt-4 block">
            <span className="label mb-1.5 block">Custom image URL</span>
            <div className="flex items-center gap-2">
              <input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onBlur={() => urlDraft.trim() !== (bd.url || '') && apply({ url: urlDraft.trim() })}
                onKeyDown={(e) => e.key === 'Enter' && apply({ url: urlDraft.trim() })}
                placeholder="https://…"
                spellCheck="false"
                autoCapitalize="off"
                className="h-10 min-w-0 flex-1 rounded-xl2 border border-glass-line bg-black/25 px-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink3 focus:border-glass-line2"
              />
              <Button onClick={() => apply({ url: urlDraft.trim() })} disabled={!urlDraft.trim()}>
                Use
              </Button>
            </div>
          </label>

          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="label">Dim</span>
              <span className="tnum font-mono text-[12px] text-ink2">{dimPct}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={dimPct}
              aria-label="Backdrop dim"
              onChange={(e) => apply({ dim: Number(e.target.value) / 100 })}
              className="h-10 w-full cursor-pointer accent-[var(--color-accent)]"
            />
          </div>
        </Section>

        <Section title="API access">
          <p className="py-2 text-[12.5px] leading-relaxed text-ink3">
            Bots and assistants (OpenClaw, scripts, cron) can drive this fleet over plain HTTPS — no inbound ports
            needed on their side. Auth is <span className="font-mono text-[11.5px] text-ink2">Authorization: Bearer
            &lt;token&gt;</span>, the same token this panel uses.{' '}
            <span className="font-mono text-[11.5px] text-ink2">GET /api/v1</span> lists every endpoint.
          </p>
          <div className="flex min-h-[42px] items-center justify-between gap-4 border-b border-glass-line/60 py-2.5">
            <span className="text-[13px] text-ink3">Endpoint</span>
            <span className="max-w-[62%] truncate font-mono text-[12.5px] text-ink">{apiBase}</span>
          </div>
          <Row label="Machine setup" hint="Copy env vars + a test call, token included" last>
            <Button icon={copied ? 'check' : 'copy'} onClick={copySetup}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </Row>
        </Section>

        <Section title="Access">
          <Row label="Change token" hint="Re-enter the access token">
            <Button
              onClick={() => {
                changeToken();
                onClose?.();
              }}
            >
              Change
            </Button>
          </Row>
          <Row label="Stop all agents" hint="Send “Stop” to every agent still running">
            <Button
              variant="danger"
              onClick={() => {
                if (confirm('Send “Stop” to every agent still running?')) stopAll();
              }}
            >
              Stop all
            </Button>
          </Row>
          <Row label="Disconnect" hint="Forget the token on this device" last>
            <Button
              variant="danger"
              onClick={() => confirm('Forget the access token on this device?') && forgetToken()}
            >
              Forget
            </Button>
          </Row>
        </Section>

        <p className="px-1 pb-2 text-[12.5px] leading-relaxed text-ink3">
          Mission Control is the command center for the AI agents running on your Mac. All computation happens on the
          workstation — this panel monitors, directs and launches agents from anywhere. Live data only: every number
          here comes straight from the fleet snapshot.
        </p>
      </div>
    </Sheet>
  );
}
