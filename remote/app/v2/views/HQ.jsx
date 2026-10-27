import HQView from '../../src/views/hq/HQ.jsx';
import { push, patchTop, focusTask } from '../lib/nav.js';
import Page from '../shell/Page.jsx';
import { useWide } from '../ui/hooks.js';

// HQ — Mia's companies and the YouTube channels. v1's HQ view (its company
// board with the photo hero transitions, the Channels section) is hosted
// as-is inside a v2 page: it already reads every colour from the theme
// tokens, so it follows v2's light and dark. Company and channel drill-downs
// live in this page's params, so the address bar (#hq/<co>, #channels/<key>)
// stays exact.
export default function HQ({ params, v5 = false }) {
  // v5.1: on an iPad the board's own header already says HQ — one title, not two
  const wide = useWide(640);
  return (
    <Page scroll={false} title={v5 && wide ? null : params.section === 'channels' ? 'Channels' : 'HQ'}>
      <div className="flex min-h-0 flex-1 flex-col" style={{ paddingBottom: 'var(--tabbar-space)' }} data-v2-hq>
        <HQView
          onClose={null}
          companyId={params.company || null}
          onCompany={(company) => patchTop({ company: company || undefined })}
          onOpenDoc={(id) => push('doc', { id })}
          onOpenTask={(id) => focusTask(id)}
          section={params.section || 'companies'}
          onSection={(section) => patchTop({ section, channel: undefined, company: undefined })}
          channelKey={params.channel || null}
          onChannel={(channel) => patchTop({ channel: channel || undefined })}
          companiesLabel={v5 ? 'Companies' : null}
        />
      </div>
    </Page>
  );
}
