<script>
  import { onMount } from 'svelte';
  import { mc, initToken } from './lib/store.svelte.js';
  import Gate from './components/Gate.svelte';
  import StatusStrip from './components/StatusStrip.svelte';
  import ConnBanner from './components/ConnBanner.svelte';
  import Dashboard from './components/Dashboard.svelte';
  import DataDeck from './components/DataDeck.svelte';
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

  let tab = $state('fleet'); // 'fleet' | 'library' | 'data' — main content area
  // #tv = the ambient wall display (TV mode). Hash-routed so a TV browser can
  // be pointed straight at …/?token=XXX#tv and never touch the app chrome.
  let tvOn = $state(typeof location !== 'undefined' && location.hash === '#tv');
  let sheet = $state(null); // 'launch' | 'settings' | null
  let openAgentId = $state(null); // full-screen agent workspace
  let openDoc = $state(null); // { id, edit } — full-screen document workspace
  // The terminal console: { agentId } with null meaning "show the picker".
  // Held separately from openAgentId so closing it drops you back where you were.
  let console_ = $state(null);
  let lastConsoleId = $state(null); // reopen on the terminal you were last driving
  let launchDocMeta = $state(null); // { ...doc meta, mode } attached to the Launch sheet
  let composer = $state(null); // { target } | null

  const active = $derived(console_ ? 'console' : sheet || tab);

  function openConsole(id = null) {
    lastConsoleId = id ?? lastConsoleId;
    console_ = { agentId: lastConsoleId };
  }

  onMount(() => {
    initToken();
    const syncTv = () => (tvOn = location.hash === '#tv');
    window.addEventListener('hashchange', syncTv);
    return () => window.removeEventListener('hashchange', syncTv);
  });

  function openAgent(id) {
    openAgentId = id;
  }

  function goto(t) {
    tab = t;
    sheet = null;
    openAgentId = null;
    openDoc = null;
    console_ = null;
  }

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
    if (dest === 'fleet') goto('fleet');
  }
</script>

{#if mc.needsToken}
  <Gate />
{/if}

{#if tvOn}
  <TvMode onclose={() => (location.hash = '')} />
{/if}

<StatusStrip />
<ConnBanner />

<div class="pb-32">
  {#if tab === 'data'}
    <DataDeck onopen={openAgent} />
  {:else if tab === 'library'}
    <Library onopen={(id) => (openDoc = { id, edit: false })} />
  {:else}
    <Dashboard onopen={openAgent} />
  {/if}
</div>

<CommandDock
  {active}
  onFleet={() => goto('fleet')}
  onLibrary={() => goto('library')}
  onData={() => goto('data')}
  onLaunch={() => (sheet = 'launch')}
  onSettings={() => (sheet = 'settings')}
  onConsole={() => openConsole()}
  onMic={() => (composer = { target: 'all' })} />

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
