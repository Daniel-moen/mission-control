<script>
  import { onMount } from 'svelte';
  import { mc, initToken } from './lib/store.svelte.js';
  import Gate from './components/Gate.svelte';
  import StatusStrip from './components/StatusStrip.svelte';
  import ConnBanner from './components/ConnBanner.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Roster from './components/Roster.svelte';
  import Overview from './components/Overview.svelte';
  import AttentionQueue from './components/AttentionQueue.svelte';
  import Library from './components/Library.svelte';
  import DocView from './components/DocView.svelte';
  import CommandDock from './components/CommandDock.svelte';
  import AgentView from './components/AgentView.svelte';
  import Launch from './components/Launch.svelte';
  import Settings from './components/Settings.svelte';
  import VoiceComposer from './components/VoiceComposer.svelte';
  import Toast from './components/Toast.svelte';
  import TvMode from './components/TvMode.svelte';
  import TerminalConsole from './components/TerminalConsole.svelte';

  // ---- layout mode ---------------------------------------------------------
  // Desktop (≥1024px) = split view: sidebar roster + main pane.
  // Phone = tabbed: Agents / Overview / Library with a bottom dock.
  let isDesktop = $state(typeof matchMedia !== 'undefined' && matchMedia('(min-width: 1024px)').matches);

  let tab = $state('agents'); // phone: 'agents' | 'overview' | 'library'
  let view = $state('overview'); // desktop main pane: 'overview' | 'library'
  let sel = $state(null); // desktop: agent filling the main pane
  let openAgentId = $state(null); // phone: full-screen agent workspace
  let openDoc = $state(null); // { id, edit } — full-screen document workspace
  // #tv = the ambient wall display (TV mode). Hash-routed so a TV browser can
  // be pointed straight at …/?token=XXX#tv and never touch the app chrome.
  let tvOn = $state(typeof location !== 'undefined' && location.hash === '#tv');
  let sheet = $state(null); // 'launch' | 'settings' | null
  // The terminal console: { agentId } with null meaning "show the picker".
  let console_ = $state(null);
  let lastConsoleId = $state(null); // reopen on the terminal you were last driving
  let launchDocMeta = $state(null); // { ...doc meta, mode } attached to the Launch sheet
  let composer = $state(null); // { target } | null

  const dockActive = $derived(sheet || tab);

  function openConsole(id = null) {
    lastConsoleId = id ?? lastConsoleId;
    console_ = { agentId: lastConsoleId };
  }

  function openAgent(id) {
    if (isDesktop) sel = id;
    else openAgentId = id;
  }

  function nav(t) {
    if (isDesktop) {
      view = t === 'agents' ? 'overview' : t;
      sel = null;
    } else {
      tab = t;
    }
    sheet = null;
    openAgentId = null;
    openDoc = null;
    console_ = null;
  }

  onMount(() => {
    initToken();
    const syncTv = () => (tvOn = location.hash === '#tv');
    window.addEventListener('hashchange', syncTv);
    const mq = matchMedia('(min-width: 1024px)');
    const syncMq = () => {
      isDesktop = mq.matches;
      // Carry an open agent across the breakpoint instead of dropping it.
      if (isDesktop && openAgentId) {
        sel = openAgentId;
        openAgentId = null;
      } else if (!isDesktop && sel) {
        openAgentId = sel;
        sel = null;
        tab = 'agents';
      }
    };
    mq.addEventListener('change', syncMq);
    return () => {
      window.removeEventListener('hashchange', syncTv);
      mq.removeEventListener('change', syncMq);
    };
  });

  // A doc just created from the Library — open it. A hand-made note/plan opens
  // in the EDITOR (it's empty, you type into it now); a research doc opens in the
  // READER (an agent is filling it in — there's nothing to type). We look the
  // kind up in the snapshot, so we wait for it to carry the new doc first.
  $effect(() => {
    const id = mc.lastCreatedDocId;
    if (!id) return;
    const meta = mc.docs.find((d) => d.id === id);
    if (!meta) return; // the snapshot hasn't caught up yet — try again next tick
    mc.lastCreatedDocId = '';
    openDoc = { id, edit: meta.kind !== 'research' };
  });

  // "Build"/"Continue" from a doc: open the Launch sheet with the doc attached.
  function launchDoc(meta, mode) {
    launchDocMeta = { ...meta, mode };
    sheet = 'launch';
  }

  function closeLaunch(dest) {
    sheet = null;
    launchDocMeta = null;
    if (dest === 'fleet') nav('agents');
  }
</script>

{#if mc.needsToken}
  <Gate />
{/if}

{#if tvOn}
  <TvMode onclose={() => (location.hash = '')} />
{/if}

{#if isDesktop}
  <!-- ============ DESKTOP: split view ============ -->
  <div class="flex h-dvh">
    <Sidebar
      {view}
      selectedId={sel}
      onnav={nav}
      onselect={openAgent}
      onLaunch={() => (sheet = 'launch')}
      onSettings={() => (sheet = 'settings')}
      onMic={() => (composer = { target: 'all' })} />

    <main class="flex min-h-0 min-w-0 flex-1 flex-col">
      <ConnBanner />
      {#if sel}
        <AgentView inline agentId={sel} onclose={() => (sel = null)} onconsole={openConsole} />
      {:else if view === 'library'}
        <div class="min-h-0 flex-1 overflow-y-auto pb-8 noscroll"><Library onopen={(id) => (openDoc = { id, edit: false })} /></div>
      {:else}
        <div class="min-h-0 flex-1 overflow-y-auto noscroll"><Overview onopen={openAgent} /></div>
      {/if}
    </main>
  </div>
{:else}
  <!-- ============ PHONE: tabs + dock ============ -->
  <StatusStrip onSettings={() => (sheet = 'settings')} />
  <ConnBanner />

  <div class="pb-32">
    {#if tab === 'overview'}
      <Overview onopen={openAgent} />
    {:else if tab === 'library'}
      <Library onopen={(id) => (openDoc = { id, edit: false })} />
    {:else}
      <div class="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-3 pt-4 sm:px-6">
        <AttentionQueue onopen={openAgent} />
        <div class="panel rounded-2xl p-1.5">
          <Roster selectedId={null} onselect={openAgent} />
        </div>
      </div>
    {/if}
  </div>

  <CommandDock
    active={dockActive}
    onAgents={() => nav('agents')}
    onOverview={() => nav('overview')}
    onLibrary={() => nav('library')}
    onLaunch={() => (sheet = 'launch')}
    onMic={() => (composer = { target: 'all' })} />
{/if}

{#if openDoc}
  <DocView docId={openDoc.id} startEditing={openDoc.edit} onclose={() => (openDoc = null)} onlaunch={launchDoc} />
{/if}

{#if openAgentId}
  <AgentView agentId={openAgentId} onclose={() => (openAgentId = null)} onconsole={openConsole} />
{/if}

{#if console_}
  <TerminalConsole agentId={console_.agentId} onselect={(id) => (lastConsoleId = id)} onclose={() => (console_ = null)} />
{/if}

{#if sheet === 'launch'}
  <Launch attachDoc={launchDocMeta} onclose={closeLaunch} />
{/if}

{#if sheet === 'settings'}
  <Settings onclose={() => (sheet = null)} />
{/if}

{#if composer}
  <VoiceComposer initialTarget={composer.target} onclose={() => (composer = null)} />
{/if}

<Toast />
