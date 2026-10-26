import { lazy, Suspense, useRef } from 'react';
import { useNav, closeSheet } from '../lib/nav.js';
import Sheet from '../ui/Sheet.jsx';
import { Spinner } from '../ui/kit.jsx';

// The app-level sheets, by name (lib/nav.js). Each body is its own chunk.

const Search = lazy(() => import('../views/Search.jsx'));
const Attach = lazy(() => import('../views/Attach.jsx'));
const forms = () => import('../views/Forms.jsx');
const Launch = lazy(() => forms().then((m) => ({ default: m.Launch })));
const NewDoc = lazy(() => forms().then((m) => ({ default: m.NewDoc })));
const Research = lazy(() => forms().then((m) => ({ default: m.Research })));
const DraftPlan = lazy(() => forms().then((m) => ({ default: m.DraftPlan })));

const SPEC = {
  search: { title: 'Search', size: 'lg', label: 'Search' },
  launch: { title: 'Launch', size: 'md' },
  attach: { title: 'Attach', size: 'md' },
  newdoc: { title: 'New document', size: 'md' },
  research: { title: 'Research', size: 'md' },
  draft: { title: 'Draft a plan', size: 'md' },
};

export default function Sheets() {
  const live = useNav((s) => s.sheet);
  // Keep drawing the last sheet while it animates away.
  const last = useRef(null);
  if (live && SPEC[live.name]) last.current = live;
  const open = !!(live && SPEC[live.name]);
  const sheet = last.current;
  const spec = sheet ? SPEC[sheet.name] : null;
  const p = sheet?.params || {};
  return (
    <Sheet open={open} onClose={closeSheet} title={spec?.title} size={spec?.size} label={spec?.label} height={sheet?.name === 'search' ? '100%' : undefined}>
      {spec && (
        <Suspense fallback={<Spinner size={22} className="mx-auto my-12 block text-ink3" />}>
          {sheet.name === 'search' && <Search key={sheet.n} initial={p.q || ''} />}
          {sheet.name === 'attach' && <Attach />}
          {sheet.name === 'launch' && <Launch key={sheet.n} attachDoc={p.doc || null} onDone={closeSheet} />}
          {sheet.name === 'newdoc' && <NewDoc onDone={closeSheet} />}
          {sheet.name === 'research' && <Research onDone={closeSheet} />}
          {sheet.name === 'draft' && <DraftPlan onDone={closeSheet} />}
        </Suspense>
      )}
    </Sheet>
  );
}
