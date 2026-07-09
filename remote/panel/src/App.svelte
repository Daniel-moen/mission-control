<script>
  import { onMount } from 'svelte';
  import { mc, initToken } from './lib/store.svelte.js';
  import Gate from './components/Gate.svelte';
  import StatusStrip from './components/StatusStrip.svelte';
  import ConnBanner from './components/ConnBanner.svelte';
  import Dashboard from './components/Dashboard.svelte';
  import DataDeck from './components/DataDeck.svelte';
  import Plans from './components/Plans.svelte';
  import PlanView from './components/PlanView.svelte';
  import CommandDock from './components/CommandDock.svelte';
  import AgentView from './components/AgentView.svelte';
  import Launch from './components/Launch.svelte';
  import Settings from './components/Settings.svelte';
  import VoiceComposer from './components/VoiceComposer.svelte';
  import Toast from './components/Toast.svelte';

  let tab = $state('fleet'); // 'fleet' | 'plans' | 'data' — main content area
  let sheet = $state(null); // 'launch' | 'settings' | null
  let openAgentId = $state(null); // full-screen agent workspace
  let openPlan = $state(null); // { id, edit } — full-screen plan workspace
  let launchPlan = $state(null); // plan meta attached to the Launch sheet
  let composer = $state(null); // { target } | null

  const active = $derived(sheet || tab);

  onMount(initToken);

  function openAgent(id) {
    openAgentId = id;
  }

  function goto(t) {
    tab = t;
    sheet = null;
    openAgentId = null;
    openPlan = null;
  }

  // A plan just created from the Plans tab — open it straight into the editor.
  $effect(() => {
    if (!mc.lastCreatedPlanId) return;
    openPlan = { id: mc.lastCreatedPlanId, edit: true };
    mc.lastCreatedPlanId = '';
  });

  // "Build" from a plan: open the Launch sheet with the plan attached.
  function buildPlan(meta) {
    launchPlan = meta;
    sheet = 'launch';
  }

  function closeLaunch(dest) {
    sheet = null;
    launchPlan = null;
    if (dest === 'fleet') goto('fleet');
  }
</script>

{#if mc.needsToken}
  <Gate />
{/if}

<StatusStrip />
<ConnBanner />

<div class="pb-32">
  {#if tab === 'data'}
    <DataDeck onopen={openAgent} />
  {:else if tab === 'plans'}
    <Plans onopen={(id) => (openPlan = { id, edit: false })} />
  {:else}
    <Dashboard onopen={openAgent} />
  {/if}
</div>

<CommandDock
  {active}
  onFleet={() => goto('fleet')}
  onPlans={() => goto('plans')}
  onData={() => goto('data')}
  onLaunch={() => (sheet = 'launch')}
  onSettings={() => (sheet = 'settings')}
  onMic={() => (composer = { target: 'all' })} />

{#if openPlan}
  <PlanView planId={openPlan.id} startEditing={openPlan.edit} onclose={() => (openPlan = null)} onbuild={buildPlan} />
{/if}

{#if openAgentId}
  <AgentView agentId={openAgentId} onclose={() => (openAgentId = null)} />
{/if}

{#if sheet === 'launch'}
  <Launch attachPlan={launchPlan} onclose={closeLaunch} />
{/if}

{#if sheet === 'settings'}
  <Settings onclose={() => (sheet = null)} />
{/if}

{#if composer}
  <VoiceComposer initialTarget={composer.target} onclose={() => (composer = null)} />
{/if}

<Toast />
