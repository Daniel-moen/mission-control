<script>
  // Full-screen plan workspace: rendered markdown by default, a raw editor on
  // demand. Saves write straight back to the file on the Mac. "Build" hands the
  // plan to the Launch sheet so agents get it as their marching orders.
  import { mc, planGet, planSave, planDelete, toast } from '../lib/store.svelte.js';
  import { renderMarkdown, ago } from '../lib/md.js';
  import Icon from './Icon.svelte';

  let { planId, startEditing = false, onclose, onbuild } = $props();

  const meta = $derived(mc.plans.find((p) => p.id === planId) || null);
  const doc = $derived(mc.planDocs[planId] || null);

  // Fetch the body when it's missing — on open, and again whenever a snapshot
  // invalidates the cached copy (the file changed on the Mac). Throttled so a
  // dead host doesn't get hammered.
  let lastReq = 0;
  $effect(() => {
    if (doc) return;
    void mc.lastSnapshotAt; // re-run per snapshot until the body lands
    if (mc.link !== 'linked') return;
    if (Date.now() - lastReq < 2500) return;
    lastReq = Date.now();
    planGet(planId);
  });

  let editing = $state(false);
  let draft = $state('');
  let armedDelete = $state(false);
  let armTimer;

  // A brand-new plan opens straight into the editor once its body arrives.
  let wantEdit = startEditing;
  $effect(() => {
    if (wantEdit && doc) {
      wantEdit = false;
      startEdit();
    }
  });

  function startEdit() {
    draft = doc?.content ?? '';
    editing = true;
  }
  function save() {
    if (!planSave(planId, draft)) return;
    editing = false;
  }
  function cancelEdit() {
    if (draft !== (doc?.content ?? '') && !confirm('Discard your edits?')) return;
    editing = false;
  }
  function armDelete() {
    if (!armedDelete) {
      armedDelete = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armedDelete = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    if (planDelete(planId)) onclose();
  }

  const title = $derived(meta?.title || doc?.title || 'Plan');
  const html = $derived(doc ? renderMarkdown(doc.content) : '');
</script>

<div class="fixed inset-0 z-[60] flex flex-col bg-bg">
  <header class="flex flex-none items-center gap-3 border-b border-line bg-surface/80 px-4 backdrop-blur sm:px-6" style="padding-top:calc(12px + var(--sat));padding-bottom:12px; box-shadow: 0 1px 0 rgba(147,200,255,0.06)">
    <button onclick={editing ? cancelEdit : onclose} aria-label={editing ? 'Cancel' : 'Close'} class="grid h-11 w-11 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name={editing ? 'close' : 'back'} size={22} /></button>
    <div class="min-w-0 flex-1">
      <h2 class="display truncate text-[19px] font-bold leading-tight tracking-tight">{title}</h2>
      <div class="hud mt-1 flex items-center gap-3 truncate">
        {#if meta?.folder}<span class="!text-ink3">{meta.folder}</span>{/if}
        {#if meta}<span class="!text-ink3">{ago(meta.updatedAt, mc.now)}</span>{/if}
        <span class="!text-ink3 normal-case tracking-normal">{planId}</span>
      </div>
    </div>
    {#if editing}
      <button onclick={save} class="flex min-h-[44px] flex-none items-center gap-2 rounded-xl bg-accent px-4 font-mono text-[12.5px] font-bold uppercase tracking-[0.12em] text-accent-ink transition active:scale-95"><Icon name="check" size={16} /> Save</button>
    {:else}
      <button onclick={startEdit} disabled={!doc} class="flex min-h-[44px] flex-none items-center gap-2 rounded-xl border border-line bg-raised/60 px-4 font-mono text-[12.5px] font-semibold text-ink2 transition active:scale-95 disabled:opacity-40">Edit</button>
      <button onclick={() => onbuild(meta)} disabled={!meta} class="flex min-h-[44px] flex-none items-center gap-2 rounded-xl bg-accent px-4 font-mono text-[12.5px] font-bold uppercase tracking-[0.12em] text-accent-ink shadow-[0_0_24px_-6px_rgba(34,217,238,0.6)] transition active:scale-95 disabled:opacity-40"><Icon name="launch" size={15} /> Build</button>
    {/if}
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto noscroll">
    {#if editing}
      <div class="mx-auto flex h-full max-w-[860px] flex-col p-4 sm:p-6">
        <textarea
          bind:value={draft}
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          class="min-h-0 w-full flex-1 resize-none rounded-2xl border border-line bg-inset px-4 py-4 font-mono text-[13.5px] leading-relaxed text-ink outline-none transition focus:border-accent/70 noscroll"
          style="min-height: 60vh"></textarea>
        <p class="mt-2 pb-2 font-mono text-[11.5px] text-ink3">Markdown. Saving writes the file on your Mac (~/.mission-control/plans/{planId}).</p>
      </div>
    {:else if doc}
      <article class="md mx-auto max-w-[860px] p-5 pb-24 sm:p-8">
        {@html html}
      </article>
      <div class="mx-auto max-w-[860px] px-5 pb-10 sm:px-8">
        <button onclick={armDelete} class="flex min-h-[44px] items-center gap-2 rounded-xl border px-4 font-mono text-[12px] font-semibold transition active:scale-95 {armedDelete ? 'border-crit bg-crit/15 text-crit glow-crit' : 'border-line bg-raised/40 text-ink3'}">
          <Icon name="trash" size={15} /> {armedDelete ? 'Tap again to delete' : 'Delete plan'}
        </button>
      </div>
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-4">
        <div class="relative grid h-14 w-14 place-items-center">
          <div class="absolute inset-0 rounded-full border-[3px] border-line2 border-t-accent" style="animation:mc-spin .9s linear infinite"></div>
        </div>
        <div class="hud">Loading plan…</div>
      </div>
    {/if}
  </main>
</div>
