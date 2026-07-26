<script>
  // Full-screen agent workspace. Owns the watch-lease lifecycle for its session:
  // acquired on open, heartbeated by the store every 3s, re-asserted on
  // reconnect, released on close. The terminal (streamed buffer + scrollback)
  // is the centerpiece; todos/plan/log ride shotgun; the sticky bottom bar
  // carries reply + mic + quick keys + Stop + two-tap Kill.
  import {
    mc, reply, kill, sendKey, watchAgent, screenInfoFor, rawScreenFor,
    agentStatus, statusLabel, agentName, fmtTokens, fmtInt, fmtMem,
  } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';
  import Terminal from './Terminal.svelte';
  import MicField from './MicField.svelte';
  import PromptControls from './PromptControls.svelte';
  import ConnBanner from './ConnBanner.svelte';
  import Icon from './Icon.svelte';

  // `inline` renders the workspace as a normal pane (desktop split view's main
  // area) instead of a full-screen overlay (phone).
  let { agentId, onclose, onconsole = null, inline = false } = $props();

  const agent = $derived(mc.agents.find((a) => a.id === agentId));
  const cls = $derived(agent ? agentStatus(agent) : 'done');
  const t = $derived(TONE[cls]);
  const todos = $derived(agent?.todos || []);
  const doneCount = $derived(todos.filter((td) => td.status === 'completed').length);
  const pct = $derived(todos.length ? Math.round((100 * doneCount) / todos.length) : null);
  const screen = $derived(agent ? screenInfoFor(agent) : { text: '', at: 0, streamed: false });
  const hasSys = $derived(agent && typeof agent.cpu === 'number');

  // Watch lease: acquire on open / agent change, release on close.
  $effect(() => {
    if (!agentId) return;
    return watchAgent(agentId);
  });

  // If the agent disappears from the snapshot, close.
  $effect(() => {
    if (!agent) onclose();
  });

  let replyText = $state('');
  function sendReply() {
    if (reply(agentId, replyText)) replyText = '';
  }

  // Two-tap kill: first tap arms for 3s, second tap fires. No modal.
  let killArmed = $state(false);
  let killTimer;
  function tapKill() {
    if (killArmed) {
      clearTimeout(killTimer);
      killArmed = false;
      kill(agentId);
      onclose();
    } else {
      killArmed = true;
      clearTimeout(killTimer);
      killTimer = setTimeout(() => (killArmed = false), 3000);
    }
  }

  const lineTone = {
    command: 'text-accent',
    tool: 'text-s3',
    text: 'text-ink',
    status: 'text-ink3 italic',
  };
</script>

{#if agent}
  <div class={inline ? 'flex h-full min-h-0 flex-col bg-bg' : 'anim-slide fixed inset-0 z-[70] flex flex-col bg-bg'}>
    <!-- header: status-colored hairline up top -->
    <header
      class="relative flex flex-none items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-xl sm:px-6"
      style="padding-top:calc(10px + var(--sat));padding-bottom:10px">
      <span class="absolute inset-x-0 top-0 h-[2px] {t.edge}"></span>
      {#if !inline}
        <button onclick={onclose} aria-label="Back" class="grid h-10 w-10 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised">
          <Icon name="back" size={22} />
        </button>
      {/if}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h2 class="truncate text-[18px] font-semibold tracking-tight">{agentName(agent)}</h2>
          {#if agent.isManager}
            <span class="flex-none rounded-md border border-mgr/40 px-1.5 py-0.5 text-[10px] font-semibold text-mgr">MGR</span>
          {/if}
          {#if agent.branch}
            <span class="hidden flex-none items-center gap-1 font-mono text-[11px] text-ink3 sm:flex">
              <Icon name="branch" size={11} /><span class="max-w-[160px] truncate">{agent.branch}</span>
            </span>
          {/if}
        </div>
        <div class="flex min-w-0 items-center gap-2 text-[12px] text-ink3">
          <span class="truncate">{agent.dir || agent.folder || ''}</span>
        </div>
      </div>

      <!-- glance stats: uptime · cost · cpu/mem -->
      <div class="hidden flex-none items-center gap-4 font-mono text-[12.5px] tabular-nums text-ink2 lg:flex">
        {#if agent.uptime}<span class="text-ink3">{agent.uptime}</span>{/if}
        <span>${(agent.cost ?? 0).toFixed(2)}</span>
        {#if hasSys}
          <span class="text-ink3">{Math.round(agent.cpu)}%{typeof agent.mem === 'number' ? ` · ${fmtMem(agent.mem)}` : ''}</span>
        {/if}
      </div>

      <span class="flex flex-none items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-semibold {t.chip}">
        {#if cls === 'working'}<span class="h-1.5 w-1.5 rounded-full bg-accent" style="animation:mc-pulse 1.4s steps(2) infinite"></span>{/if}
        {statusLabel(cls)}
      </span>
      {#if inline}
        <button onclick={onclose} aria-label="Close workspace" class="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink3 transition hover:bg-raised hover:text-ink2">
          <Icon name="close" size={18} />
        </button>
      {/if}
    </header>

    {#if !inline}<ConnBanner />{/if}

    <!-- body: terminal centerpiece + side rail -->
    <main class="mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 noscroll sm:p-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:overflow-hidden">
      <!-- LEFT: menu banner + terminal -->
      <div class="flex min-h-0 min-w-0 flex-col gap-3">
        {#if agent.controllable}
          <PromptControls {agent} screen={rawScreenFor(agent)} />
        {/if}
        <div class="min-h-[46vh] flex-1 lg:min-h-0">
          <Terminal
            text={screen.text}
            at={screen.at}
            streamed={screen.streamed}
            controllable={agent.controllable}
            onexpand={onconsole && agent.controllable ? () => onconsole(agentId) : null}
            fill />
        </div>
      </div>

      <!-- RIGHT: stats, plan, log, objective -->
      <div class="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pb-2 lg:noscroll">
        <div class="grid grid-cols-2 gap-2.5">
          {#each [['Runtime', agent.uptime || '—'], ['Cost', '$' + (agent.cost ?? 0).toFixed(2)], ['Tokens', fmtTokens(agent.tokens ?? 0)], ['Turns', fmtInt(agent.turns ?? 0)]] as [k, v] (k)}
            <div class="panel rounded-xl p-3.5">
              <div class="hud">{k}</div>
              <div class="mt-1.5 text-[19px] font-semibold tracking-tight tabular-nums">{v}</div>
            </div>
          {/each}
        </div>

        {#if cls === 'working'}
          <div class="panel flex items-center justify-between rounded-xl px-4 py-3">
            <span class="hud">Burn</span>
            <span class="text-[17px] font-semibold tabular-nums text-accent">{fmtInt(Math.round(agent.tokensPerSec ?? 0))} <span class="text-[12px] font-normal text-ink3">tok/s</span></span>
          </div>
        {/if}

        {#if cls === 'exited'}
          <div class="rounded-xl border border-crit/30 bg-crit/[0.06] p-4">
            <div class="flex items-center gap-2 text-[13px] font-semibold text-crit"><Icon name="alert" size={15} />Process exited</div>
            <p class="mt-1 text-[13px] leading-relaxed text-ink2">The claude process behind this session is gone. The last terminal output is preserved above.</p>
          </div>
        {/if}

        {#if todos.length}
          <section class="panel rounded-xl p-4">
            <div class="mb-3 flex items-center justify-between">
              <span class="hud">Plan</span>
              <span class="font-mono text-[12px] text-ink3">{doneCount}/{todos.length} · {pct}%</span>
            </div>
            <div class="mb-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div class="h-full rounded-full bg-accent transition-[width] duration-500" style="width:{pct}%"></div>
            </div>
            <div class="flex flex-col gap-2">
              {#each todos as td}
                <div class="flex items-baseline gap-2.5 text-[14px] {td.status === 'completed' ? 'text-ink3 line-through' : td.status === 'in_progress' ? 'font-semibold text-ink' : 'text-ink2'}">
                  <span class="w-4 flex-none font-mono text-[12px] {td.status === 'completed' ? 'text-ok' : td.status === 'in_progress' ? 'text-accent' : 'text-ink3'}">
                    {td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '▶' : '○'}
                  </span>
                  <span class="min-w-0 break-words [overflow-wrap:anywhere]">{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}</span>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <section>
          <div class="hud mb-2">Recent log</div>
          <div class="max-h-56 overflow-y-auto rounded-xl border border-line bg-inset p-3 font-mono text-[12px] leading-relaxed noscroll">
            {#each agent.log || [] as l}
              <div class="truncate {lineTone[l.kind] || 'text-ink2'}">{l.text}</div>
            {:else}
              <div class="text-ink3">No activity yet.</div>
            {/each}
          </div>
        </section>

        {#if agent.prompt}
          <section class="panel rounded-xl p-4">
            <div class="hud mb-2">Objective</div>
            <p class="max-h-32 overflow-y-auto break-words [overflow-wrap:anywhere] text-[13.5px] leading-relaxed text-ink2 noscroll">{agent.prompt}</p>
          </section>
        {/if}
      </div>
    </main>

    <!-- sticky bottom action bar -->
    <footer class="flex-none border-t border-line bg-surface/85 px-4 backdrop-blur-xl sm:px-6" style="padding-top:10px;padding-bottom:calc(10px + var(--sab))">
      <div class="mx-auto max-w-[1400px]">
        {#if agent.controllable}
          <div class="mb-2.5 flex items-center gap-2 overflow-x-auto pb-0.5 noscroll">
            <!-- quick keys -->
            {#each [['esc', 'Esc'], ['up', '↑'], ['down', '↓'], ['enter', '⏎']] as [k, lbl] (k)}
              <button onclick={() => sendKey(agentId, k)} aria-label={k} class="grid h-10 w-11 flex-none place-items-center rounded-lg border border-line bg-raised text-[14px] font-medium text-ink2 transition active:scale-90">{lbl}</button>
            {/each}
            <span class="h-5 w-px flex-none bg-line"></span>
            {#each ['Continue', 'Yes', 'Approve plan'] as q (q)}
              <button onclick={() => reply(agentId, q)} class="h-10 flex-none rounded-lg border border-line bg-raised px-3.5 text-[13px] font-medium text-ink2 transition active:scale-95">{q}</button>
            {/each}
            <button onclick={() => reply(agentId, 'Stop')} class="h-10 flex-none rounded-lg border border-crit/40 px-3.5 text-[13px] font-medium text-crit transition active:scale-95">■ Stop</button>
            <span class="min-w-2 flex-1"></span>
            <button
              onclick={tapKill}
              class="flex h-10 flex-none items-center gap-1.5 rounded-lg border px-3.5 text-[13px] font-semibold transition active:scale-95 {killArmed ? 'border-crit bg-crit text-white' : 'border-crit/40 text-crit'}">
              {killArmed ? 'Tap again to kill' : 'Kill'}
            </button>
          </div>
          <MicField bind:value={replyText} placeholder="Message this agent…" onsubmit={sendReply} />
        {:else}
          <div class="flex items-center justify-between gap-3">
            <p class="text-[13px] text-ink3">Read-only — this agent’s terminal can’t be driven remotely.</p>
            <button
              onclick={tapKill}
              class="flex h-10 flex-none items-center gap-1.5 rounded-lg border px-3.5 text-[13px] font-semibold transition active:scale-95 {killArmed ? 'border-crit bg-crit text-white' : 'border-crit/40 text-crit'}">
              {killArmed ? 'Tap again to kill' : 'Kill'}
            </button>
          </div>
        {/if}
      </div>
    </footer>
  </div>
{/if}
