<script>
  // The document library — one central directory of markdown files living in
  // ~/.mission-control/library on the Mac, written by you OR by agents (a
  // research agent streams its report straight into a file here). This view is
  // the reading room: filter by kind/status/tag, search titles instantly and
  // bodies over the wire, and open any doc into its full-screen workspace.
  //
  // Kinds carry a colour the whole app speaks: plan = accent cyan, research =
  // mgr violet, note = neutral ink. The maps below hold FULL Tailwind class
  // strings (never interpolated) so the JIT actually emits them.
  import {
    mc,
    docCreate,
    docSearch,
    research,
    launch,
    toast,
    kindLabel,
    docStatusLabel,
    allTags,
    filterDocs,
  } from '../lib/store.svelte.js';
  import { dictate, speechSupported } from '../lib/speech.js';
  import { ago } from '../lib/md.js';
  import Icon from './Icon.svelte';

  let { onopen } = $props(); // onopen(docId)

  const KIND = {
    plan: { icon: 'plan', text: 'text-accent', ring: 'border-accent/60 bg-accent/12 text-accent', chip: 'border-accent/40 text-accent', spine: 'from-accent/70 via-accent/25' },
    research: { icon: 'research', text: 'text-mgr', ring: 'border-mgr/60 bg-mgr/12 text-mgr', chip: 'border-mgr/40 text-mgr', spine: 'from-mgr/70 via-mgr/25' },
    note: { icon: 'note', text: 'text-ink2', ring: 'border-line2 bg-raised/60 text-ink2', chip: 'border-line2 text-ink3', spine: 'from-line2 via-line' },
  };
  const kindOf = (k) => KIND[k] || KIND.note;

  const STATUS = {
    draft: 'border-line2 text-ink3',
    active: 'border-accent/50 text-accent',
    done: 'border-ok/50 text-ok',
    archived: 'border-line text-ink3/70',
  };
  const statusChip = (s) => STATUS[s] || STATUS.draft;

  // Older Mac hosts predate the whole library — they ship no `docs` field at all.
  const hostTooOld = $derived(!!mc.snapshot && !('docs' in mc.snapshot));

  // ---- filters + search -------------------------------------------------------
  let kindFilter = $state('all');
  let statusFilter = $state('all');
  let tagFilter = $state('all');
  let q = $state('');

  const tags = $derived(allTags(mc.docs));

  // Instant local sieve over the metadata every card already shows.
  const localDocs = $derived(filterDocs(mc.docs, { kind: kindFilter, status: statusFilter, tag: tagFilter, q }));

  // Kind chip counts respect the OTHER active filters (status/tag/query) so a
  // count reads as "how many I'd see if I picked this kind", not a raw total.
  function kindCount(k) {
    return filterDocs(mc.docs, { kind: k, status: statusFilter, tag: tagFilter, q }).length;
  }

  const KIND_TABS = [
    ['all', 'All'],
    ['plan', 'Plans'],
    ['research', 'Research'],
    ['note', 'Notes'],
  ];
  const STATUS_TABS = [
    ['all', 'All'],
    ['draft', 'Draft'],
    ['active', 'Working'],
    ['done', 'Done'],
    ['archived', 'Archived'],
  ];

  // Full-text body search over the wire, debounced. The host answers into
  // mc.search; we only trust a result whose `q` still matches what's typed, so a
  // slow reply for an old query can never clobber the current one.
  let searchTimer;
  $effect(() => {
    const query = q.trim();
    clearTimeout(searchTimer);
    if (query.length < 2 || mc.link !== 'linked') return;
    searchTimer = setTimeout(() => docSearch(query), 350);
    return () => clearTimeout(searchTimer);
  });

  // Docs the local sieve missed but the host found deep in a body. Only shown for
  // the CURRENT query, and never duplicating a card already on screen.
  const bodyHits = $derived.by(() => {
    const query = q.trim();
    if (query.length < 2 || !mc.search || mc.search.q !== query) return [];
    const shown = new Set(localDocs.map((d) => d.id));
    const out = [];
    for (const hit of mc.search.hits || []) {
      if (shown.has(hit.id)) continue;
      const meta = mc.docs.find((d) => d.id === hit.id);
      if (meta) out.push({ meta, snippets: hit.snippets || [] });
    }
    return out;
  });

  // Escape agent-authored snippet text BEFORE wrapping query matches in <mark>:
  // the snippet is arbitrary repo/body content and must never reach {@html} raw.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function highlight(snippet) {
    const safe = esc(snippet);
    const query = q.trim();
    if (!query) return safe;
    const rx = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    return safe.replace(rx, '<mark>$1</mark>');
  }

  const FALLBACK_MODELS = [
    { flag: 'claude-fable-5', label: 'Fable 5' },
    { flag: 'opus', label: 'Opus 4.8' },
    { flag: 'claude-sonnet-5', label: 'Sonnet 5' },
  ];
  const models = $derived(mc.models.length ? mc.models : FALLBACK_MODELS);

  // ---- new-doc kind picker ----------------------------------------------------
  let picking = $state(false);
  function newDoc(kind) {
    picking = false;
    if (kind === 'research') {
      researching = true;
      return;
    }
    // Created on the Mac; the docCreate ack carries the id and App opens it in
    // the editor (a hand-made doc is empty — you type into it now).
    docCreate({ title: `Untitled ${kindLabel(kind).toLowerCase()}`, kind, dir: mc.lastDir || '' });
  }

  // ---- research sheet ---------------------------------------------------------
  // One agent researches a topic and writes its report straight into a new
  // library file; you read it here as it lands.
  let researching = $state(false);
  let rTopic = $state('');
  let rSubject = $state('');
  let rTags = $state('');
  let rDir = $state('');
  let rModel = $state('opus');
  let rDirTouched = false;
  $effect(() => {
    if (researching && !rDirTouched && !rDir && mc.lastDir) rDir = mc.lastDir;
  });

  let rMic = $state(null);
  function toggleResearchMic() {
    if (rMic) {
      rMic.stop();
      return;
    }
    rMic = dictate({ base: rTopic, onText: (t) => (rTopic = t), onEnd: () => (rMic = null), onError: () => (rMic = null) });
  }

  function toTags(s) {
    return (s || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  function launchResearch() {
    const topic = rTopic.trim();
    if (!topic) return toast('What should the agent research?');
    const fix = (f) => (f === 'default' ? '' : f);
    if (!research({ topic, subject: rSubject.trim(), dir: rDir.trim(), model: fix(rModel), tags: toTags(rTags) })) return;
    researching = false;
    rTopic = '';
    rSubject = '';
    rTags = '';
    toast('Research agent launched — its report lands here');
  }

  // ---- draft-a-plan-with-agent sheet ------------------------------------------
  // A read-only planning agent explores the project and presents a plan with
  // ExitPlanMode; the Mac captures that plan into the library automatically.
  let drafting = $state(false);
  let goal = $state('');
  let dDir = $state('');
  let dModel = $state('opus');
  let dDirTouched = false;
  $effect(() => {
    if (drafting && !dDirTouched && !dDir && mc.lastDir) dDir = mc.lastDir;
  });

  let dMic = $state(null);
  function toggleDraftMic() {
    if (dMic) {
      dMic.stop();
      return;
    }
    dMic = dictate({ base: goal, onText: (t) => (goal = t), onEnd: () => (dMic = null), onError: () => (dMic = null) });
  }

  function draftMission(g) {
    return (
      'Research this project and draft a thorough implementation plan for the goal below. Do NOT write any code — you are in plan mode. ' +
      'Explore the codebase first, then produce one complete, well-structured markdown plan: a clear title as a # heading, context, a concrete step-by-step approach naming the exact files to touch, risks, and how to verify. ' +
      'Present the finished plan with ExitPlanMode — Mission Control saves it to the library automatically.\n\nGOAL: ' +
      g
    );
  }
  function launchDraft() {
    const g = goal.trim();
    if (!g) return toast('Describe what to plan first');
    const fix = (f) => (f === 'default' ? '' : f);
    if (!launch({ mission: draftMission(g), dir: dDir.trim(), managerModel: null, workerModels: [fix(dModel)], planMode: true })) return;
    drafting = false;
    goal = '';
    toast('Planning agent launched — its plan lands here when ready');
  }
</script>

<div class="mx-auto w-full max-w-[1400px] px-4 pt-4 sm:px-6">
  <div class="mb-3 flex flex-wrap items-center gap-3">
    <span class="hud !text-accent">Library</span>
    <span class="h-px min-w-6 flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
    <button onclick={() => (researching = true)} class="flex min-h-[44px] items-center gap-2 rounded-xl bg-mgr px-3.5 py-2 font-mono text-[12px] font-bold text-[#160f2e] shadow-[0_0_24px_-8px_rgba(167,139,250,0.7)] transition active:scale-95">
      <Icon name="research" size={15} /> Research
    </button>
    <button onclick={() => (drafting = true)} class="flex min-h-[44px] items-center gap-2 rounded-xl border border-mgr/50 bg-mgr/10 px-3.5 py-2 font-mono text-[12px] font-semibold text-mgr transition active:scale-95">
      <Icon name="bolt" size={15} /> Draft plan
    </button>
    <button onclick={() => (picking = true)} class="flex min-h-[44px] items-center gap-2 rounded-xl border border-accent/50 bg-accent/10 px-3.5 py-2 font-mono text-[12px] font-semibold text-accent transition active:scale-95">
      <Icon name="note" size={15} /> New doc
    </button>
  </div>

  {#if hostTooOld}
    <div class="panel rounded-[22px] p-8 text-center">
      <div class="display text-[17px] font-bold">Your Mac app is out of date</div>
      <p class="mx-auto mt-2 max-w-[440px] font-mono text-[12.5px] leading-relaxed text-ink3">The document library lives on your Mac. Rebuild and relaunch Mission Control there to start syncing plans, research, and notes.</p>
    </div>
  {:else}
    <!-- filter bar: kind (with counts) · status · tags -->
    <div class="mb-3 flex flex-col gap-2.5">
      <div class="flex flex-wrap gap-2">
        {#each KIND_TABS as [k, label]}
          <button onclick={() => (kindFilter = k)} class="flex min-h-[40px] items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-[12px] transition active:scale-95 {kindFilter === k ? 'border-accent/60 bg-accent/12 text-accent' : 'border-line bg-raised/60 text-ink2'}">
            {label}
            <span class="tabular-nums {kindFilter === k ? 'text-accent/70' : 'text-ink3'}">{kindCount(k)}</span>
          </button>
        {/each}
      </div>
      <div class="flex flex-wrap gap-2">
        {#each STATUS_TABS as [s, label]}
          <button onclick={() => (statusFilter = s)} class="min-h-[36px] rounded-full border px-3 py-1 font-mono text-[11.5px] transition active:scale-95 {statusFilter === s ? 'border-ink2/50 bg-raised text-ink' : 'border-line bg-raised/40 text-ink3'}">{label}</button>
        {/each}
      </div>
      {#if tags.length}
        <div class="flex flex-wrap gap-2">
          <button onclick={() => (tagFilter = 'all')} class="flex min-h-[36px] items-center gap-1 rounded-full border px-3 py-1 font-mono text-[11.5px] transition active:scale-95 {tagFilter === 'all' ? 'border-ink2/50 bg-raised text-ink' : 'border-line bg-raised/40 text-ink3'}"><Icon name="tag" size={12} /> All tags</button>
          {#each tags as t}
            <button onclick={() => (tagFilter = tagFilter === t ? 'all' : t)} class="min-h-[36px] rounded-full border px-3 py-1 font-mono text-[11.5px] transition active:scale-95 {tagFilter === t ? 'border-accent/60 bg-accent/12 text-accent' : 'border-line bg-raised/40 text-ink3'}">#{t}</button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- search -->
    <div class="mb-4 flex items-center gap-2">
      <div class="relative w-full max-w-md">
        <span class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink3"><Icon name="search" size={16} /></span>
        <input
          bind:value={q}
          placeholder="Search titles instantly, bodies deeply…"
          class="panel h-11 w-full rounded-full pl-11 pr-4 font-mono text-[14px] outline-none transition focus:border-accent" />
      </div>
      {#if q.trim()}
        <button onclick={() => (q = '')} class="h-11 flex-none rounded-full border border-line bg-surface px-4 font-mono text-[13px] font-semibold text-ink2 transition active:scale-95">Clear ✕</button>
      {/if}
    </div>

    {#if !mc.docs.length}
      <div class="panel rounded-[22px] p-8 text-center">
        <div class="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-line bg-raised/60 text-accent"><Icon name="book" size={26} /></div>
        <div class="display text-[17px] font-bold">Your library is empty</div>
        <p class="mx-auto mt-2 max-w-[480px] font-mono text-[12.5px] leading-relaxed text-ink3">
          The library is a folder of markdown files (<span class="text-ink2">~/.mission-control/library</span>) on your Mac — written by you or by agents, readable from anywhere. Send an agent to <span class="text-mgr">research</span> a topic, <span class="text-accent">draft a plan</span>, or start a note by hand.
        </p>
      </div>
    {:else if !localDocs.length && !bodyHits.length}
      <div class="panel rounded-[22px] p-8 text-center">
        <div class="display text-[16px] font-bold">Nothing matches</div>
        <p class="mx-auto mt-2 max-w-[420px] font-mono text-[12.5px] leading-relaxed text-ink3">Try a different kind, status, tag, or search term.</p>
      </div>
    {:else}
      {#if localDocs.length}
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {#each localDocs as d (d.id)}
            {@render card(d)}
          {/each}
        </div>
      {/if}

      {#if bodyHits.length}
        <div class="mt-6 mb-3 flex items-center gap-3">
          <span class="hud">Found in body — {bodyHits.length}</span>
          <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        </div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {#each bodyHits as h (h.meta.id)}
            <button onclick={() => onopen(h.meta.id)} class="panel panel-hover anim-rise relative flex flex-col gap-2 overflow-hidden rounded-[22px] p-5 text-left transition active:scale-[0.99]">
              <span class="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b {kindOf(h.meta.kind).spine} to-transparent"></span>
              <div class="flex items-start gap-3">
                <div class="grid h-9 w-9 flex-none place-items-center rounded-xl border {kindOf(h.meta.kind).ring}"><Icon name={kindOf(h.meta.kind).icon} size={18} /></div>
                <div class="min-w-0 flex-1">
                  <div class="display truncate text-[16px] font-bold leading-tight">{h.meta.title}</div>
                  {#if h.meta.subject}<div class="truncate font-mono text-[12px] text-ink2">{h.meta.subject}</div>{/if}
                </div>
              </div>
              <div class="flex flex-col gap-1.5">
                {#each h.snippets.slice(0, 3) as snip}
                  <p class="snippet line-clamp-2 rounded-lg border border-line bg-inset/60 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-ink3">{@html highlight(snip)}</p>
                {/each}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
</div>

{#snippet card(d)}
  {@const k = kindOf(d.kind)}
  <button onclick={() => onopen(d.id)} class="panel panel-hover anim-rise relative flex flex-col gap-2 overflow-hidden rounded-[22px] p-5 text-left transition active:scale-[0.99]">
    <span class="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b {k.spine} to-transparent"></span>
    <div class="flex items-start gap-3">
      <div class="relative grid h-9 w-9 flex-none place-items-center rounded-xl border {k.ring}">
        <Icon name={k.icon} size={18} />
        {#if d.kind === 'research' && d.status === 'active'}
          <span class="absolute -right-1 -top-1 flex h-3 w-3"><span class="absolute inline-flex h-full w-full rounded-full bg-accent/70" style="animation:mc-ping 1.6s ease-out infinite"></span><span class="relative inline-flex h-3 w-3 rounded-full bg-accent glow-accent"></span></span>
        {/if}
      </div>
      <div class="min-w-0 flex-1">
        <div class="display truncate text-[16px] font-bold leading-tight">{d.title}</div>
        {#if d.subject}<div class="mt-0.5 truncate font-mono text-[12.5px] font-semibold {k.text}">{d.subject}</div>{/if}
      </div>
      <span class="flex-none rounded-md border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider {statusChip(d.status)}">{docStatusLabel(d.status)}</span>
    </div>

    {#if d.preview}
      <p class="line-clamp-2 font-mono text-[12px] leading-relaxed text-ink3">{d.preview}</p>
    {/if}

    {#if (d.tags || []).length}
      <div class="flex flex-wrap gap-1.5">
        {#each d.tags.slice(0, 4) as t}
          <span class="rounded-md border {k.chip} px-1.5 py-px font-mono text-[10.5px]">#{t}</span>
        {/each}
      </div>
    {/if}

    <div class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink3">
      {#if d.folder}<span class="flex items-center gap-1"><Icon name="folder" size={12} />{d.folder}</span>{/if}
      <span>{ago(d.updatedAt, mc.now)}</span>
      {#if d.words}<span>{d.words.toLocaleString()} words</span>{/if}
      <span class="rounded-md border px-1.5 py-px {d.session ? 'border-mgr/40 text-mgr' : 'border-line2 text-ink3'}">{d.session ? 'agent' : 'you'}</span>
    </div>
  </button>
{/snippet}

<!-- new-doc kind picker -->
{#if picking}
  <div class="fixed inset-0 z-[80] flex items-end justify-center bg-bg/80 backdrop-blur-sm sm:items-center" onclick={(e) => e.target === e.currentTarget && (picking = false)} role="presentation">
    <div class="panel anim-rise w-full max-w-[460px] rounded-t-[26px] p-5 sm:rounded-[26px]" style="padding-bottom:calc(20px + var(--sab))">
      <div class="mb-3 flex items-center gap-3">
        <span class="hud !text-accent">New document</span>
        <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        <button onclick={() => (picking = false)} aria-label="Close" class="grid h-11 w-11 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={20} /></button>
      </div>
      <div class="grid gap-2.5">
        {#each [['plan', 'A build plan you can hand to a fleet'], ['research', 'Send an agent to research and write it for you'], ['note', 'A free-form note to keep']] as [k, blurb]}
          {@const kk = kindOf(k)}
          <button onclick={() => newDoc(k)} class="flex items-center gap-3 rounded-xl border border-line bg-raised/60 p-3.5 text-left transition active:scale-[0.98]">
            <div class="grid h-10 w-10 flex-none place-items-center rounded-xl border {kk.ring}"><Icon name={kk.icon} size={19} /></div>
            <div class="min-w-0">
              <div class="display text-[15px] font-bold {kk.text}">{kindLabel(k)}</div>
              <div class="font-mono text-[11.5px] leading-snug text-ink3">{blurb}</div>
            </div>
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<!-- research sheet -->
{#if researching}
  <div class="fixed inset-0 z-[80] flex items-end justify-center bg-bg/80 backdrop-blur-sm sm:items-center" onclick={(e) => e.target === e.currentTarget && (researching = false)} role="presentation">
    <div class="panel anim-rise w-full max-w-[560px] rounded-t-[26px] p-5 sm:rounded-[26px]" style="padding-bottom:calc(20px + var(--sab))">
      <div class="mb-3 flex items-center gap-3">
        <span class="hud !text-mgr">Research with an agent</span>
        <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        {#if speechSupported}
          <button onclick={toggleResearchMic} aria-label="Dictate topic" class="grid h-11 w-11 flex-none place-items-center rounded-xl border transition active:scale-95 {rMic ? 'border-crit bg-crit/15 text-crit glow-crit' : 'border-line bg-raised/60 text-ink2'}" style={rMic ? 'animation:mc-ring 1.4s ease-out infinite' : ''}><Icon name="mic" size={18} /></button>
        {/if}
        <button onclick={() => (researching = false)} aria-label="Close" class="grid h-11 w-11 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={20} /></button>
      </div>
      <textarea bind:value={rTopic} rows="3" placeholder="What should the agent research?" class="min-h-20 w-full resize-y rounded-xl border border-line bg-inset px-4 py-3 text-[16px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70 noscroll"></textarea>
      <input bind:value={rSubject} placeholder="Subject / company (optional)" class="mt-3 w-full rounded-xl border border-line bg-inset px-4 py-3 text-[15px] text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70" />
      <input bind:value={rTags} placeholder="Tags, comma separated (optional)" class="mt-3 w-full rounded-xl border border-line bg-inset px-4 py-3 font-mono text-[14px] text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70" />
      <input bind:value={rDir} oninput={() => (rDirTouched = true)} placeholder="~/path/to/project (optional)" class="mt-3 w-full rounded-xl border border-line bg-inset px-4 py-3 font-mono text-[14px] text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70" />
      {#if mc.knownDirs.length}
        <div class="mt-2 flex flex-wrap gap-2">
          {#each mc.knownDirs as dd}
            <button onclick={() => { rDir = dd; rDirTouched = true; }} class="min-h-[40px] rounded-xl border px-3 py-1.5 font-mono text-[12px] transition active:scale-95 {dd === rDir ? 'border-mgr/60 bg-mgr/12 text-mgr' : 'border-line bg-raised/60 text-ink2'}">{dd.split('/').filter(Boolean).pop() || dd}</button>
          {/each}
        </div>
      {/if}
      <div class="mt-3 flex items-center gap-3">
        <select bind:value={rModel} class="min-h-[48px] flex-1 rounded-xl border border-line2 bg-raised px-4 py-3 text-[15px] text-ink outline-none transition focus:border-mgr/70">
          {#each models as m}<option value={m.flag}>{m.label}</option>{/each}
        </select>
        <button onclick={launchResearch} class="min-h-[48px] rounded-xl bg-mgr px-5 font-mono text-[13px] font-bold uppercase tracking-[0.14em] text-[#160f2e] transition active:scale-95">Research</button>
      </div>
      <p class="mt-3 font-mono text-[11.5px] leading-relaxed text-ink3">One agent researches and writes its report straight into the library — you can read it here as it lands.</p>
    </div>
  </div>
{/if}

<!-- draft-a-plan-with-agent sheet -->
{#if drafting}
  <div class="fixed inset-0 z-[80] flex items-end justify-center bg-bg/80 backdrop-blur-sm sm:items-center" onclick={(e) => e.target === e.currentTarget && (drafting = false)} role="presentation">
    <div class="panel anim-rise w-full max-w-[560px] rounded-t-[26px] p-5 sm:rounded-[26px]" style="padding-bottom:calc(20px + var(--sab))">
      <div class="mb-3 flex items-center gap-3">
        <span class="hud !text-mgr">Draft a plan with an agent</span>
        <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        {#if speechSupported}
          <button onclick={toggleDraftMic} aria-label="Dictate goal" class="grid h-11 w-11 flex-none place-items-center rounded-xl border transition active:scale-95 {dMic ? 'border-crit bg-crit/15 text-crit glow-crit' : 'border-line bg-raised/60 text-ink2'}" style={dMic ? 'animation:mc-ring 1.4s ease-out infinite' : ''}><Icon name="mic" size={18} /></button>
        {/if}
        <button onclick={() => (drafting = false)} aria-label="Close" class="grid h-11 w-11 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={20} /></button>
      </div>
      <textarea bind:value={goal} rows="3" placeholder="What should the plan achieve?" class="min-h-20 w-full resize-y rounded-xl border border-line bg-inset px-4 py-3 text-[16px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70 noscroll"></textarea>
      <input bind:value={dDir} oninput={() => (dDirTouched = true)} placeholder="~/path/to/project" class="mt-3 w-full rounded-xl border border-line bg-inset px-4 py-3 font-mono text-[14px] text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70" />
      {#if mc.knownDirs.length}
        <div class="mt-2 flex flex-wrap gap-2">
          {#each mc.knownDirs as dd}
            <button onclick={() => { dDir = dd; dDirTouched = true; }} class="min-h-[40px] rounded-xl border px-3 py-1.5 font-mono text-[12px] transition active:scale-95 {dd === dDir ? 'border-mgr/60 bg-mgr/12 text-mgr' : 'border-line bg-raised/60 text-ink2'}">{dd.split('/').filter(Boolean).pop() || dd}</button>
          {/each}
        </div>
      {/if}
      <div class="mt-3 flex items-center gap-3">
        <select bind:value={dModel} class="min-h-[48px] flex-1 rounded-xl border border-line2 bg-raised px-4 py-3 text-[15px] text-ink outline-none transition focus:border-mgr/70">
          {#each models as m}<option value={m.flag}>{m.label}</option>{/each}
        </select>
        <button onclick={launchDraft} class="min-h-[48px] rounded-xl bg-mgr px-5 font-mono text-[13px] font-bold uppercase tracking-[0.14em] text-[#160f2e] transition active:scale-95">Draft</button>
      </div>
      <p class="mt-3 font-mono text-[11.5px] leading-relaxed text-ink3">Launches one agent in read-only plan mode. It explores the project, drafts the plan, and the plan file appears here — nothing gets built until you say so.</p>
    </div>
  </div>
{/if}

<style>
  /* Search snippets arrive as escaped text with <mark> wrapped around query
     matches; Svelte scopes styles, so :global reaches the injected element. */
  .snippet :global(mark) {
    background: color-mix(in oklab, var(--color-accent) 30%, transparent);
    color: var(--color-accent-bright);
    border-radius: 3px;
    padding: 0 2px;
  }
</style>
