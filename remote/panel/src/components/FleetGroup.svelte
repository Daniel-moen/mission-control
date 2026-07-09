<script>
  // A fleet unit: manager + workers as one bordered section with the command
  // tree (dashes march manager → workers while dispatching). Collapse state
  // persists per fleet in localStorage `mc_fleet_open`; a fleet auto-expands
  // when a member needs input (unless the user explicitly collapsed it).
  import { untrack } from 'svelte';
  import { agentStatus, statusLabel, agentName, fmtInt, fmtTokens, fleetMembers, fleetProgress } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';
  import Icon from './Icon.svelte';

  let { group, onopen } = $props();

  const manager = $derived(group.manager);
  const workers = $derived(group.workers);
  const members = $derived(fleetMembers(group));
  // Stable 1-based label for each worker (managers stay unnumbered — they're MGR).
  const workerNum = $derived(new Map(workers.map((w, i) => [w.id, i + 1])));
  const title = $derived(
    group.fleet?.title || (manager && agentName(manager)) || group.fleet?.dir?.split('/').filter(Boolean).pop() || 'Fleet',
  );

  // Member status tally for the header summary.
  const tally = $derived.by(() => {
    const c = { working: 0, waiting: 0, done: 0, exited: 0 };
    for (const a of members) c[agentStatus(a)]++;
    return c;
  });
  const prog = $derived(fleetProgress(group));

  // The manager's plan is the fleet's shared instruction set.
  const plan = $derived((manager?.todos || []).slice());
  const planDone = $derived(plan.filter((t) => t.status === 'completed').length);

  // Manager is "dispatching" while it's actively working — that's when the
  // connectors animate, as if handing instructions down to the workers.
  const dispatching = $derived(manager?.status === 'active');

  function todoCount(a) {
    const td = a.todos || [];
    if (!td.length) return null;
    return { done: td.filter((t) => t.status === 'completed').length, total: td.length };
  }

  // ── collapse / expand ──────────────────────────────────────────────────────
  const LS_KEY = 'mc_fleet_open';
  function readOpen() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  }
  let userChoice = $state(
    untrack(() => {
      const stored = readOpen();
      return group.id in stored ? !!stored[group.id] : null;
    }),
  );
  const needsInput = $derived(members.some((a) => {
    const st = agentStatus(a);
    return st === 'waiting' || st === 'exited';
  }));
  // User's explicit choice wins; otherwise open while someone needs input.
  const expanded = $derived(userChoice !== null ? userChoice : needsInput);
  function toggle() {
    userChoice = !expanded;
    const m = readOpen();
    m[group.id] = userChoice;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(m));
    } catch {}
  }

  // Collapsed strip: surface the ones that need you as loud chips, the rest as
  // compact status dots — a whole fleet's state in one glanceable row.
  const waitingMembers = $derived(members.filter((a) => agentStatus(a) === 'waiting'));
  const restMembers = $derived(members.filter((a) => agentStatus(a) !== 'waiting'));
</script>

<section
  class="fleet panel overflow-hidden rounded-[22px] !border-mgr/30"
  class:dispatch={dispatching}>
  <!-- ── header : this is a FLEET · tap to expand/collapse ─────────────────── -->
  <button
    type="button"
    onclick={toggle}
    aria-expanded={expanded}
    class="flex min-h-[64px] w-full flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 bg-mgr/[0.06] px-5 py-4 text-left transition hover:bg-mgr/[0.1]">
    <span class="grid h-9 w-9 flex-none place-items-center rounded-xl bg-mgr/15 text-mgr" style="box-shadow:0 0 18px -4px rgba(167,139,250,0.5)">
      <Icon name="fleet" size={18} />
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <h3 class="display truncate text-[19px] font-bold leading-tight tracking-tight">{title}</h3>
        <span class="hud flex-none rounded-md border border-mgr/50 px-1.5 py-0.5 !text-mgr">FLEET</span>
      </div>
      <div class="mt-0.5 flex items-center gap-2 font-mono text-[12px] text-ink3">
        <span>{members.length} agents</span>
        <span class="opacity-40">·</span>
        <span>{manager ? '1 manager' : 'no manager'} · {workers.length} worker{workers.length === 1 ? '' : 's'}</span>
      </div>
    </div>
    <!-- live status summary -->
    <div class="flex flex-none items-center gap-1.5">
      {#each ['working', 'waiting', 'exited', 'done'] as k (k)}
        {#if tally[k]}
          <span class="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold {TONE[k].chip}"><span class="h-1.5 w-1.5 rounded-full {TONE[k].dot}"></span>{tally[k]}</span>
        {/if}
      {/each}
    </div>
    <span class="flex-none text-ink3 transition-transform duration-200 {expanded ? 'rotate-90' : ''}">
      <Icon name="chevron" size={18} />
    </span>
  </button>

  <!-- aggregate fleet progress (always visible — a glance even when collapsed) -->
  {#if prog}
    <div class="flex items-center gap-3 px-5 pt-4">
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-inset">
        <div class="h-full rounded-full bg-mgr transition-[width] duration-500" style="width:{prog.pct}%"></div>
      </div>
      <span class="font-mono text-[11px] tabular-nums text-ink3">{prog.done}/{prog.total} tasks</span>
    </div>
  {/if}

  <!-- ── collapsed strip : glanceable, waiting workers surfaced loud ───────── -->
  {#if !expanded}
    <div class="flex flex-wrap items-center gap-1.5 px-5 pb-4 pt-3">
      {#each waitingMembers as m (m.id)}
        {@const wn = workerNum.get(m.id)}
        <button
          onclick={() => onopen(m.id)}
          title="{wn ? `#${wn} ` : ''}{agentName(m)} — Needs you"
          class="flex min-h-[36px] items-center gap-1.5 rounded-full border border-warn/40 bg-warn/12 px-3 py-1 text-[12px] font-bold text-warn transition hover:bg-warn/20 active:scale-95">
          {#if wn}
            <span class="font-mono opacity-80">#{wn}</span>
          {:else}
            <span class="relative flex h-1.5 w-1.5">
              <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60"></span>
              <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-warn"></span>
            </span>
          {/if}
          <span class="max-w-[140px] truncate">{agentName(m)}</span>
        </button>
      {/each}
      {#each restMembers as m (m.id)}
        {@const rc = agentStatus(m)}
        {@const wn = workerNum.get(m.id)}
        <button
          onclick={() => onopen(m.id)}
          title="{wn ? `#${wn} ` : ''}{agentName(m)} — {statusLabel(rc)}"
          class="relative grid h-8 w-8 flex-none place-items-center rounded-full border bg-raised/60 transition hover:border-line2 active:scale-95 {rc === 'working' ? 'border-accent/50' : rc === 'exited' ? 'border-crit/50' : 'border-line'}">
          {#if rc === 'working'}<span class="absolute inset-0 animate-ping rounded-full bg-accent/20"></span>{/if}
          {#if wn}
            <span class="relative font-mono text-[11px] font-bold {TONE[rc].text}">{wn}</span>
          {:else}
            <span class="relative inline-flex h-2 w-2 rounded-full {TONE[rc].dot}"></span>
          {/if}
        </button>
      {/each}
      <span class="ml-1 text-[11px] text-ink3">Tap to expand</span>
    </div>
  {/if}

  {#if expanded}
  <div class="p-5">
    <!-- ── manager node + shared plan ─────────────────────────────────────── -->
    {#if manager}
      {@const mcls = agentStatus(manager)}
      <button
        onclick={() => onopen(manager.id)}
        class="group block w-full rounded-2xl border border-mgr/25 bg-mgr/[0.05] p-4 text-left transition hover:border-mgr/45 active:scale-[0.99]">
        <div class="flex items-center gap-2.5">
          <span class="relative flex h-2.5 w-2.5 flex-none">
            {#if mcls === 'working'}<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-mgr opacity-60"></span>{/if}
            <span class="relative inline-flex h-2.5 w-2.5 rounded-full {mcls === 'working' ? 'bg-mgr' : TONE[mcls].dot}"></span>
          </span>
          <span class="display min-w-0 flex-1 truncate text-[17px] font-bold tracking-tight">{agentName(manager)}</span>
          {#if manager.branch}
            <span class="hidden flex-none items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-ink2 sm:flex"><Icon name="branch" size={10} /><span class="max-w-[110px] truncate">{manager.branch}</span></span>
          {/if}
          <span class="flex-none rounded-md border border-mgr/50 px-1.5 py-0.5 text-[10px] font-extrabold tracking-wider text-mgr">MGR</span>
          <span class="flex-none rounded-full px-2 py-0.5 text-[10px] font-bold {TONE[mcls].chip}">{statusLabel(mcls)}</span>
        </div>
        <p class="mt-2 line-clamp-1 break-words [overflow-wrap:anywhere] font-mono text-[12px] text-ink2">{manager.activity || '—'}</p>

        {#if plan.length}
          <div class="mt-3 border-t border-mgr/15 pt-3">
            <div class="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-mgr/90">
              <Icon name="pulse" size={12} /> Mission plan
              <span class="ml-auto font-mono tracking-normal text-ink3">{planDone}/{plan.length}</span>
            </div>
            <div class="flex flex-col gap-1">
              {#each plan.slice(0, 5) as t}
                <div class="flex items-baseline gap-2 text-[13px] {t.status === 'completed' ? 'text-ink3 line-through' : t.status === 'in_progress' ? 'font-semibold text-ink' : 'text-ink2'}">
                  <span class="w-3 flex-none font-mono text-[11px] {t.status === 'completed' ? 'text-ok' : t.status === 'in_progress' ? 'text-mgr' : 'text-ink3'}">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'}</span>
                  <span class="min-w-0 truncate">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
                </div>
              {/each}
              {#if plan.length > 5}<div class="pl-5 text-[11px] text-ink3">+{plan.length - 5} more</div>{/if}
            </div>
          </div>
        {/if}
      </button>
    {/if}

    <!-- ── command tree : connectors flow manager → workers ───────────────── -->
    {#if workers.length}
      <div class="ftree mt-1" class:flowing={dispatching}>
        {#each workers as w, i (w.id)}
          {@const wcls = agentStatus(w)}
          {@const tc = todoCount(w)}
          <div class="fbranch" class:on={wcls === 'working'} style="--c:{TONE[wcls].css}">
            <button
              onclick={() => onopen(w.id)}
              class="worker w-full rounded-xl border border-line bg-raised/60 p-3.5 text-left transition hover:border-line2 active:scale-[0.985] {wcls === 'waiting' ? 'ring-1 ring-warn/40' : ''}">
              <div class="flex items-center gap-2">
                <span class="grid h-5 w-5 flex-none place-items-center rounded-md border border-line2 bg-inset font-mono text-[10px] font-bold tabular-nums text-ink3">{i + 1}</span>
                <span class="relative flex h-2 w-2 flex-none">
                  {#if wcls === 'working'}<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60"></span>{/if}
                  <span class="relative inline-flex h-2 w-2 rounded-full {TONE[wcls].dot}"></span>
                </span>
                <span class="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight">{agentName(w)}</span>
                {#if w.branch}
                  <span class="hidden max-w-[110px] flex-none truncate font-mono text-[10px] text-ink3 lg:inline">{w.branch}</span>
                {/if}
                <span class="flex-none rounded-full px-2 py-0.5 text-[10px] font-bold {TONE[wcls].chip}">{statusLabel(wcls)}</span>
              </div>
              <p class="mt-1.5 line-clamp-2 min-h-[2.4em] break-words [overflow-wrap:anywhere] font-mono text-[11.5px] leading-snug {wcls === 'working' ? 'text-ink2' : wcls === 'waiting' ? 'text-warn' : 'text-ink3'}">{w.activity || '—'}</p>
              <div class="mt-2 flex items-center gap-2.5">
                {#if tc}
                  <div class="h-1 flex-1 overflow-hidden rounded-full bg-inset">
                    <div class="h-full rounded-full bg-accent transition-[width] duration-500" style="width:{Math.round((100 * tc.done) / tc.total)}%"></div>
                  </div>
                  <span class="flex-none font-mono text-[10px] tabular-nums text-ink3">{tc.done}/{tc.total}</span>
                {:else}
                  <span class="flex-1"></span>
                {/if}
                {#if wcls === 'working'}
                  <span class="flex-none font-mono text-[10px] tabular-nums text-ink2">{fmtInt(Math.round(w.tokensPerSec ?? 0))} t/s</span>
                {:else}
                  <span class="flex-none font-mono text-[10px] tabular-nums text-ink3">{fmtTokens(w.tokens ?? 0)}</span>
                {/if}
              </div>
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
  {/if}
</section>

<style>
  /* The tree hangs workers off a left spine. Each branch draws its own spine
     segment (::before) + elbow (::after) so the rail naturally stops at the
     last worker with no dangling stub. */
  .ftree {
    position: relative;
    padding-left: 26px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .fbranch {
    position: relative;
  }
  /* vertical spine segment — solid + faint by default */
  .fbranch::before {
    content: '';
    position: absolute;
    left: -18px;
    top: -12px; /* reach up to the previous node / manager */
    bottom: 50%;
    width: 2px;
    background: color-mix(in oklab, var(--c) 34%, transparent);
  }
  .fbranch:first-child::before {
    top: -8px;
  }
  /* horizontal elbow into the worker node */
  .fbranch::after {
    content: '';
    position: absolute;
    left: -18px;
    top: 50%;
    width: 18px;
    height: 2px;
    background: color-mix(in oklab, var(--c) 34%, transparent);
  }
  /* When the fleet is dispatching AND this worker is working, the connectors
     turn into marching dashes flowing toward the worker. */
  .ftree.flowing .fbranch.on::before {
    background-image: repeating-linear-gradient(
      180deg,
      color-mix(in oklab, var(--c) 85%, transparent) 0 5px,
      transparent 5px 12px
    );
    background-size: 2px 12px;
    animation: mc-flow-y 0.7s linear infinite;
  }
  .ftree.flowing .fbranch.on::after {
    background-image: repeating-linear-gradient(
      90deg,
      color-mix(in oklab, var(--c) 85%, transparent) 0 5px,
      transparent 5px 12px
    );
    background-size: 12px 2px;
    animation: mc-flow-x 0.7s linear infinite;
  }
  /* pulse the elbow node-side dot for working branches */
  .fbranch.on::after {
    box-shadow: 8px 0 0 -6px color-mix(in oklab, var(--c) 90%, transparent);
  }

  .fleet.dispatch {
    animation: mc-dispatch 2.6s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .ftree.flowing .fbranch.on::before,
    .ftree.flowing .fbranch.on::after,
    .fleet.dispatch {
      animation: none;
    }
  }
</style>
