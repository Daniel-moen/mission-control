<script>
  // A fleet unit: manager + workers as one bordered section with a quiet
  // command tree. Collapse state persists per fleet in localStorage
  // `mc_fleet_open`; a fleet auto-expands when a member needs input (unless
  // the user explicitly collapsed it).
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

<section class="panel overflow-hidden rounded-2xl">
  <!-- ── header : this is a fleet · tap to expand/collapse ─────────────────── -->
  <button
    type="button"
    onclick={toggle}
    aria-expanded={expanded}
    class="flex min-h-[60px] w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 text-left transition hover:bg-white/[0.02] {expanded ? 'border-b border-line' : ''}">
    <span class="grid h-8 w-8 flex-none place-items-center rounded-lg bg-mgr/12 text-mgr">
      <Icon name="fleet" size={16} />
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <h3 class="truncate text-[16px] font-semibold leading-tight tracking-tight">{title}</h3>
        <span class="flex-none rounded-md border border-mgr/40 px-1.5 py-0.5 text-[10px] font-semibold text-mgr">FLEET</span>
      </div>
      <div class="mt-0.5 flex items-center gap-2 text-[12px] text-ink3">
        <span>{manager ? '1 manager' : 'no manager'} · {workers.length} worker{workers.length === 1 ? '' : 's'}</span>
        {#if prog}
          <span class="opacity-50">·</span>
          <span class="tabular-nums">{prog.done}/{prog.total} tasks</span>
        {/if}
      </div>
    </div>
    <!-- live status summary -->
    <div class="flex flex-none items-center gap-1.5">
      {#each ['working', 'waiting', 'exited', 'done'] as k (k)}
        {#if tally[k]}
          <span class="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold {TONE[k].chip}"><span class="h-1.5 w-1.5 rounded-full {TONE[k].dot}"></span>{tally[k]}</span>
        {/if}
      {/each}
    </div>
    <span class="flex-none text-ink3 transition-transform duration-200 {expanded ? 'rotate-90' : ''}">
      <Icon name="chevron" size={16} />
    </span>
  </button>

  <!-- ── collapsed strip : glanceable, waiting workers surfaced loud ───────── -->
  {#if !expanded}
    <div class="flex flex-wrap items-center gap-1.5 px-4 pb-3.5">
      {#each waitingMembers as m (m.id)}
        {@const wn = workerNum.get(m.id)}
        <button
          onclick={() => onopen(m.id)}
          title="{wn ? `#${wn} ` : ''}{agentName(m)} — Needs you"
          class="flex min-h-[34px] items-center gap-1.5 rounded-full border border-warn/35 bg-warn/10 px-3 py-1 text-[12px] font-semibold text-warn transition hover:bg-warn/15 active:scale-95">
          {#if wn}<span class="font-mono opacity-80">#{wn}</span>{/if}
          <span class="max-w-[140px] truncate">{agentName(m)}</span>
        </button>
      {/each}
      {#each restMembers as m (m.id)}
        {@const rc = agentStatus(m)}
        {@const wn = workerNum.get(m.id)}
        <button
          onclick={() => onopen(m.id)}
          title="{wn ? `#${wn} ` : ''}{agentName(m)} — {statusLabel(rc)}"
          class="grid h-8 w-8 flex-none place-items-center rounded-full border bg-raised/60 transition hover:border-line2 active:scale-95 {rc === 'working' ? 'border-accent/40' : rc === 'exited' ? 'border-crit/40' : 'border-line'}">
          {#if wn}
            <span class="font-mono text-[11px] font-semibold {TONE[rc].text}">{wn}</span>
          {:else}
            <span class="inline-flex h-2 w-2 rounded-full {TONE[rc].dot}"></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if expanded}
  <div class="p-4">
    <!-- ── manager node + shared plan ─────────────────────────────────────── -->
    {#if manager}
      {@const mcls = agentStatus(manager)}
      <button
        onclick={() => onopen(manager.id)}
        class="group block w-full rounded-xl border border-mgr/20 bg-mgr/[0.04] p-3.5 text-left transition hover:border-mgr/35 active:scale-[0.995]">
        <div class="flex items-center gap-2.5">
          <span class="relative flex h-2 w-2 flex-none">
            {#if mcls === 'working'}<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-mgr opacity-50"></span>{/if}
            <span class="relative inline-flex h-2 w-2 rounded-full {mcls === 'working' ? 'bg-mgr' : TONE[mcls].dot}"></span>
          </span>
          <span class="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">{agentName(manager)}</span>
          {#if manager.branch}
            <span class="hidden max-w-[110px] flex-none truncate font-mono text-[11px] text-ink3 sm:inline">{manager.branch}</span>
          {/if}
          <span class="flex-none rounded-md border border-mgr/40 px-1.5 py-0.5 text-[10px] font-semibold text-mgr">MGR</span>
          <span class="flex-none rounded-full px-2 py-0.5 text-[10px] font-semibold {TONE[mcls].chip}">{statusLabel(mcls)}</span>
        </div>
        <p class="mt-2 line-clamp-1 break-words [overflow-wrap:anywhere] text-[12.5px] text-ink2">{manager.activity || '—'}</p>

        {#if plan.length}
          <div class="mt-3 border-t border-mgr/12 pt-3">
            <div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-mgr/90">
              Plan
              <span class="ml-auto font-mono font-normal text-ink3">{planDone}/{plan.length}</span>
            </div>
            <div class="flex flex-col gap-1">
              {#each plan.slice(0, 5) as t}
                <div class="flex items-baseline gap-2 text-[13px] {t.status === 'completed' ? 'text-ink3 line-through' : t.status === 'in_progress' ? 'font-medium text-ink' : 'text-ink2'}">
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

    <!-- ── command tree : hairlines hang workers off the manager ──────────── -->
    {#if workers.length}
      <div class="ftree mt-1">
        {#each workers as w, i (w.id)}
          {@const wcls = agentStatus(w)}
          {@const tc = todoCount(w)}
          <div class="fbranch">
            <button
              onclick={() => onopen(w.id)}
              class="w-full rounded-xl border border-line bg-raised/40 p-3 text-left transition hover:border-line2 active:scale-[0.995] {wcls === 'waiting' ? 'ring-1 ring-warn/35' : ''}">
              <div class="flex items-center gap-2">
                <span class="grid h-5 w-5 flex-none place-items-center rounded-md bg-white/[0.05] font-mono text-[10px] font-semibold tabular-nums text-ink3">{i + 1}</span>
                <span class="relative flex h-2 w-2 flex-none">
                  {#if wcls === 'working'}<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-50"></span>{/if}
                  <span class="relative inline-flex h-2 w-2 rounded-full {TONE[wcls].dot}"></span>
                </span>
                <span class="min-w-0 flex-1 truncate text-[14px] font-medium tracking-tight">{agentName(w)}</span>
                {#if w.branch}
                  <span class="hidden max-w-[110px] flex-none truncate font-mono text-[10px] text-ink3 lg:inline">{w.branch}</span>
                {/if}
                <span class="flex-none rounded-full px-2 py-0.5 text-[10px] font-semibold {TONE[wcls].chip}">{statusLabel(wcls)}</span>
              </div>
              <p class="mt-1.5 line-clamp-2 min-h-[2.5em] break-words [overflow-wrap:anywhere] text-[12px] leading-snug {wcls === 'working' ? 'text-ink2' : wcls === 'waiting' ? 'text-warn' : 'text-ink3'}">{w.activity || '—'}</p>
              <div class="mt-2 flex items-center gap-2.5">
                {#if tc}
                  <div class="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
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
     last worker with no dangling stub. Static hairlines — no animation. */
  .ftree {
    position: relative;
    padding-left: 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fbranch {
    position: relative;
  }
  .fbranch::before {
    content: '';
    position: absolute;
    left: -16px;
    top: -10px; /* reach up to the previous node / manager */
    bottom: 50%;
    width: 1px;
    background: var(--color-line2);
  }
  .fbranch:first-child::before {
    top: -8px;
  }
  .fbranch::after {
    content: '';
    position: absolute;
    left: -16px;
    top: 50%;
    width: 16px;
    height: 1px;
    background: var(--color-line2);
  }
</style>
