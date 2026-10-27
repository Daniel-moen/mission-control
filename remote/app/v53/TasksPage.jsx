import { useMC, miaStart } from '../src/lib/store.js';
import { useNav } from '../v2/lib/nav.js';
import { Button, Empty } from '../v2/ui/kit.jsx';
import Page from '../v2/shell/Page.jsx';
import Tasks from '../v2/views/mia/Tasks.jsx';

// Mia's board as a page of its own (tasks 0491, 0502): in v5.3 the Mia place IS the
// chat, so her task list opens from the side panel (or ⌘K, or a chip) in the
// pane beside it — the same board v2/v5 show behind Chat | Tasks.
export default function TasksPage() {
  const mia = useMC((s) => s.mia);
  const focus = useNav((s) => s.focusTask);
  const live = (mia?.tasks || []).filter((t) => ['queued', 'asking', 'running', 'checking'].includes(t.status)).length;
  return (
    <Page title="Tasks" subtitle={live ? `${live} live` : null} maxW={820}>
      <div className="pb-6" data-tasks-page>
        {mia ? (
          <Tasks mia={mia} focus={focus} />
        ) : (
          <Empty icon="tasks" title="Mia is off" hint="Her board fills in when your Mac reports her." action={<Button tone="primary" icon="play" onClick={() => miaStart()}>Start Mia</Button>} />
        )}
      </div>
    </Page>
  );
}
