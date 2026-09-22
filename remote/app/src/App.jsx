import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { useMC } from './lib/store.js';
import { useMedia } from './lib/hooks.js';

import Backdrop from './shell/Backdrop.jsx';
import TopBar from './shell/TopBar.jsx';
import Dock from './shell/Dock.jsx';
import Window from './shell/Window.jsx';
import ConnBanner from './shell/ConnBanner.jsx';
import Gate from './shell/Gate.jsx';
import CommandPalette from './shell/CommandPalette.jsx';
import Toast from './ui/Toast.jsx';

import Home from './views/home/Home.jsx';
import AttentionCards from './views/home/AttentionCards.jsx';
import Fleet from './views/fleet/Fleet.jsx';
import Insights from './views/insights/Insights.jsx';
import Library from './views/library/Library.jsx';
import DocView from './views/library/DocView.jsx';
import AgentView from './views/agent/AgentView.jsx';
import TerminalConsole from './views/agent/TerminalConsole.jsx';
import Launch from './views/launch/Launch.jsx';
import Settings from './views/settings/Settings.jsx';
import VoiceComposer from './views/composer/VoiceComposer.jsx';
import TvMode from './views/modes/TvMode.jsx';
import CarMode from './views/modes/CarMode.jsx';

// ---------------------------------------------------------------------------
// The shell. A photograph fills the window; everything else is glass floating
// on top of it. There is no permanent sidebar and no tab bar — Home is the
// resting state and each place you go opens as a window over the scene.
//
// Overlay-owning views: Launch / Settings / VoiceComposer render their own
// Sheet, and TerminalConsole / TvMode / CarMode their own full-screen
// takeover, so App renders them bare. AgentView / Insights / Library / DocView
// draw their own headers inside a CHROMELESS Window; Fleet is a plain list so
// its Window keeps the standard title bar.

const withHash = (h) => `${location.pathname}${location.search}${h ? '#' + h : ''}`;

export default function App() {
  const needsToken = useMC((s) => s.needsToken);
  const lastCreatedDocId = useMC((s) => s.lastCreatedDocId);
  const docs = useMC((s) => s.docs);
  const agentCount = useMC((s) => s.agents.length);
  const desktop = useMedia('(min-width: 1024px)');

  const [win, setWin] = useState(null); // null | 'fleet' | 'insights' | 'library'
  const [sel, setSel] = useState(null); // agent id → Agent window
  const [openDoc, setOpenDoc] = useState(null); // { id, edit }
  const [sheet, setSheet] = useState(null); // 'launch' | 'settings' | null
  const [console_, setConsole] = useState(null); // { agentId } — null id = picker
  const [lastConsoleId, setLastConsoleId] = useState(null);
  const [composer, setComposer] = useState(null); // { target } | null
  const [palette, setPalette] = useState(false);
  const [launchDocMeta, setLaunchDocMeta] = useState(null);
  const [tvOn, setTvOn] = useState(false);
  const [carOn, setCarOn] = useState(false);

  // ---- navigation --------------------------------------------------------
  const nav = useCallback((key) => {
    setSheet(null);
    setConsole(null);
    setOpenDoc(null);
    setSel(null);
    setWin(key === 'home' ? null : key);
  }, []);

  const openAgent = useCallback(
    (id) => {
      setOpenDoc(null);
      setSel(id);
      // Desktop keeps the roster beside the workspace — split feel, no sidebar.
      if (desktop) setWin('fleet');
    },
    [desktop],
  );

  const openConsole = useCallback(
    (id = null) => {
      const target = id ?? lastConsoleId;
      setLastConsoleId(target);
      setConsole({ agentId: target });
    },
    [lastConsoleId],
  );

  // "Build"/"Continue" from a doc: open the Launch sheet with the doc attached.
  const launchDoc = useCallback((meta, mode) => {
    setLaunchDocMeta({ ...meta, mode });
    setSheet('launch');
  }, []);

  const closeLaunch = useCallback(
    (dest) => {
      setSheet(null);
      setLaunchDocMeta(null);
      if (dest === 'fleet') nav('fleet');
    },
    [nav],
  );

  // Carry an open agent across the breakpoint instead of dropping it.
  useEffect(() => {
    if (desktop && sel) setWin('fleet');
  }, [desktop, sel]);

  // A doc just created from the Library — open it. A hand-made note/plan opens
  // in the EDITOR (it's empty, you type into it now); a research doc opens in
  // the READER (an agent is filling it in — there's nothing to type). We look
  // the kind up in the snapshot, so we wait for it to carry the new doc first.
  useEffect(() => {
    if (!lastCreatedDocId) return;
    const meta = (docs || []).find((d) => d.id === lastCreatedDocId);
    if (!meta) return; // the snapshot hasn't caught up yet — try again next tick
    useMC.setState({ lastCreatedDocId: '' });
    setOpenDoc({ id: lastCreatedDocId, edit: meta.kind !== 'research' });
  }, [lastCreatedDocId, docs]);

  // ---- hash routes -------------------------------------------------------
  // Deep links are load-bearing: #agent/<id>, #doc/<id>, #console/<id>,
  // #fleet, #insights, #library, #launch, #settings, #tv, #car.
  const applyHash = useCallback(() => {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    setTvOn(h === 'tv');
    setCarOn(h === 'car');
    if (h === 'tv' || h === 'car') return;

    const [head, ...rest] = h.split('/');
    const id = rest.join('/');
    if (head === 'agent' && id) {
      setSheet(null);
      setOpenDoc(null);
      setSel(id);
    } else if (head === 'doc' && id) {
      setSheet(null);
      setOpenDoc({ id, edit: false });
    } else if (head === 'console') {
      setLastConsoleId(id || null);
      setConsole({ agentId: id || null });
    } else if (head === 'launch') {
      setSheet('launch');
    } else if (head === 'settings') {
      setSheet('settings');
    } else if (head === 'fleet' || head === 'insights' || head === 'library') {
      setSheet(null);
      setConsole(null);
      setOpenDoc(null);
      setSel(null);
      setWin(head);
    } else if (!head) {
      setSheet(null);
      setConsole(null);
      setOpenDoc(null);
      setSel(null);
      setWin(null);
    }
  }, []);

  useEffect(() => {
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [applyHash]);

  // Keep the address bar in step with where you actually are. replaceState
  // never fires hashchange, so this can't loop back into applyHash().
  useEffect(() => {
    let h = '';
    if (tvOn) h = 'tv';
    else if (carOn) h = 'car';
    else if (console_) h = console_.agentId ? `console/${console_.agentId}` : 'console';
    else if (sheet === 'launch') h = 'launch';
    else if (sheet === 'settings') h = 'settings';
    else if (openDoc) h = `doc/${openDoc.id}`;
    else if (sel) h = `agent/${sel}`;
    else if (win) h = win;
    const want = withHash(h);
    if (location.pathname + location.search + location.hash !== want) {
      history.replaceState(null, '', want);
    }
  }, [tvOn, carOn, console_, sheet, openDoc, sel, win]);

  // ---- keyboard ----------------------------------------------------------
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        // One handler, one close — the topmost overlay and nothing else.
        if (tvOn || carOn) location.hash = '';
        else if (palette) setPalette(false);
        else if (console_) setConsole(null);
        else if (composer) setComposer(null);
        else if (sheet) closeLaunch();
        else if (openDoc) setOpenDoc(null);
        else if (sel) setSel(null);
        else if (win) setWin(null);
        return;
      }
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      const jump = { 1: 'home', 2: 'fleet', 3: 'insights', 4: 'library' }[e.key];
      if (jump) {
        e.preventDefault();
        nav(jump);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tvOn, carOn, palette, console_, composer, sheet, openDoc, sel, win, nav, closeLaunch]);

  // ---- window composition ------------------------------------------------
  const mainKind = openDoc ? 'doc' : sel ? 'agent' : win === 'insights' ? 'insights' : win === 'library' ? 'library' : null;
  // Desktop keeps at most two large windows: a 360px column plus one main.
  const leftKind = desktop && !openDoc && (win === 'fleet' || sel) ? 'fleet' : desktop && openDoc && win === 'library' ? 'library' : null;
  const phoneKind = mainKind || (win === 'fleet' ? 'fleet' : null);
  const dockActive = sel || win === 'fleet' ? 'fleet' : win === 'insights' ? 'insights' : win === 'library' ? 'library' : 'home';

  const fleetWindow = (size) => (
    <Window
      key="fleet"
      size={size}
      title="Fleet"
      subtitle={`${agentCount} agent${agentCount === 1 ? '' : 's'}`}
      onClose={() => nav('home')}
    >
      <Fleet selectedId={sel} onSelect={openAgent} />
    </Window>
  );

  const mainWindow = (kind, size) => {
    if (kind === 'doc')
      return (
        <Window key={`doc:${openDoc.id}`} size={size} onClose={() => setOpenDoc(null)}>
          <DocView
            docId={openDoc.id}
            startEditing={openDoc.edit}
            onClose={() => setOpenDoc(null)}
            onLaunch={launchDoc}
          />
        </Window>
      );
    if (kind === 'agent')
      return (
        <Window key={`agent:${sel}`} size={size} onClose={() => setSel(null)}>
          <AgentView agentId={sel} inline onClose={() => setSel(null)} onConsole={openConsole} />
        </Window>
      );
    if (kind === 'insights')
      return (
        <Window key="insights" size={size} onClose={() => nav('home')}>
          <Insights onOpen={openAgent} onClose={() => nav('home')} />
        </Window>
      );
    if (kind === 'library')
      return (
        <Window key="library" size={size} onClose={() => nav('home')}>
          <Library onOpen={(id) => setOpenDoc({ id, edit: false })} onClose={() => nav('home')} />
        </Window>
      );
    if (kind === 'fleet') return fleetWindow(size);
    return null;
  };

  const homeScene = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Home
        onOpenAgent={openAgent}
        onFleet={() => nav('fleet')}
        onLaunch={() => setSheet('launch')}
      />
      <div className="flex-none pb-4">
        <AttentionCards onOpen={openAgent} />
      </div>
    </div>
  );

  if (needsToken) {
    return (
      <>
        <Backdrop />
        <Gate />
      </>
    );
  }

  // The takeovers paint their own scene; keeping the shell mounted underneath
  // only bleeds the Home headline through their glass.
  if (tvOn) return <TvMode onClose={() => (location.hash = '')} />;
  if (carOn) return <CarMode onClose={() => (location.hash = '')} />;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <Backdrop />
      {/* A phone window covers the bar, and its icons would ghost through the glass. */}
      {(desktop || !phoneKind) && (
        <TopBar
          onPalette={() => setPalette(true)}
          onLaunch={() => setSheet('launch')}
          onSettings={() => setSheet('settings')}
        />
      )}
      <ConnBanner />

      <main
        className="relative z-10 flex min-h-0 flex-1 flex-col"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 92px)' }}
      >
        {desktop ? (
          <div className="flex min-h-0 flex-1 gap-3 px-4 pt-1">
            <AnimatePresence initial={false}>{leftKind === 'fleet' ? fleetWindow('column') : null}</AnimatePresence>
            <AnimatePresence initial={false}>
              {leftKind === 'library' ? mainWindow('library', 'column') : null}
            </AnimatePresence>
            <div className="relative flex min-h-0 flex-1 flex-col">
              <AnimatePresence mode="wait" initial={false}>
                {mainKind ? mainWindow(mainKind, 'main') : null}
              </AnimatePresence>
              {!mainKind && homeScene}
            </div>
          </div>
        ) : (
          // A phone window covers the scene outright — rendering Home beneath
          // it only gives the window's blur something distracting to sample.
          !phoneKind && homeScene
        )}
      </main>

      {!desktop && <AnimatePresence>{phoneKind ? mainWindow(phoneKind, 'full') : null}</AnimatePresence>}

      <Dock
        active={dockActive}
        onSelect={nav}
        onMic={() => setComposer({ target: 'all' })}
        onLaunch={() => setSheet('launch')}
      />

      {console_ && (
        <TerminalConsole
          agentId={console_.agentId}
          onSelect={(id) => setLastConsoleId(id)}
          onClose={() => setConsole(null)}
        />
      )}
      {sheet === 'launch' && <Launch attachDoc={launchDocMeta} onClose={closeLaunch} />}
      {sheet === 'settings' && <Settings onClose={() => setSheet(null)} />}
      {composer && <VoiceComposer initialTarget={composer.target} onClose={() => setComposer(null)} />}

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onOpenAgent={openAgent}
        onNav={nav}
        onLaunch={() => setSheet('launch')}
        onSettings={() => setSheet('settings')}
        onOpenDoc={(id) => setOpenDoc({ id, edit: false })}
      />
      <Toast />
    </div>
  );
}
