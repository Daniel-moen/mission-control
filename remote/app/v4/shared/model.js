import { useMemo } from 'react';
import { agentStatus } from '../../src/lib/store.js';
import { useLive, splitName, toMs, ago } from '../../v3/shared/live.js';

// v4 (task 0446): one list of "things" — every live object the panel knows
// about, each with a kind, a title and an attention score. The three
// directions differ in WHERE these live and HOW you reach them (a stage Mia
// fills, a map of rooms, a stack ordered by attention); the things are the
// same, read from v1's store via v3's live layer.
//
//   kind: need (a question waiting on Daniel) · mia (her latest word) ·
//         agent · doc · task · pulse (spend, tokens/s, allowance)

const DAY = 24 * 3600e3;

export function useThings() {
  const L = useLive();
  return useMemo(() => {
    const now = L.now;
    const out = [];
    for (const it of L.items) {
      if (it.kind === 'mia') {
        const q = it.question;
        out.push({
          key: `need:${q.questionId}`, kind: 'need', from: 'mia', id: q.questionId, q,
          title: q.text, eyebrow: `Mia asks${q.taskId ? ` · #${q.taskId}` : ''}`,
          options: (q.options?.length ? q.options : ['Yes', 'No']).map(String),
          at: toMs(q.askedAt), score: 100,
        });
      } else if (it.agent) {
        const a = it.agent;
        const n = splitName(a);
        out.push({
          key: `need:${a.id}`, kind: 'need', from: 'agent', id: a.id, agent: a, prompt: it.prompt,
          title: it.prompt?.question || (it.kind === 'exited' ? 'Finished — have a look' : a.activity || 'Waiting for your input'),
          eyebrow: `${n.proj} asks`, options: it.prompt ? it.prompt.options.slice(0, 4).map((o) => o.label) : it.kind === 'exited' ? [] : ['Continue'],
          at: now, score: it.kind === 'exited' ? 70 : 95,
        });
      }
    }
    if (L.lastMia) {
      out.push({
        key: 'mia', kind: 'mia', id: 'mia', title: L.lastMia.text.replace(/^\(voice\)\s*/, ''), eyebrow: `Mia · ${ago(toMs(L.lastMia.at), now)}`,
        at: toMs(L.lastMia.at), score: L.unread ? 80 : 45, unread: L.unread,
      });
    }
    const asking = new Set(out.filter((t) => t.kind === 'need' && t.from === 'agent').map((t) => t.id));
    for (const a of L.crew) {
      if (asking.has(a.id)) continue;
      const n = splitName(a);
      const st = agentStatus(a);
      const working = st === 'working';
      out.push({
        key: `agent:${a.id}`, kind: 'agent', id: a.id, agent: a, title: n.what || n.proj, eyebrow: n.proj,
        sub: a.activity || '', status: st, tps: a.tokensPerSec || 0, cost: a.cost || 0, working,
        at: now, score: working ? 50 + Math.min(10, (a.tokensPerSec || 0) / 10) : 12,
      });
    }
    for (const t of L.tasks) {
      if (t.status === 'asking') continue; // its question is already a need
      out.push({
        key: `task:${t.id}`, kind: 'task', id: t.id, task: t, title: t.title, eyebrow: `Task ${t.id} · ${t.status}`,
        at: toMs(t.updatedAt), score: t.status === 'running' ? 34 : 22,
      });
    }
    for (const d of L.recentDocs.slice(0, 5)) {
      const at = toMs(d.updatedAt);
      out.push({
        key: `doc:${d.id}`, kind: 'doc', id: d.id, doc: d, title: d.title || d.id, eyebrow: `${d.kind || 'note'}${d.subject ? ` · ${d.subject}` : ''}`,
        sub: d.summary || d.excerpt || '', at, score: now - at < 2 * 3600e3 ? 40 : now - at < DAY ? 26 : 14,
      });
    }
    out.push({
      key: 'pulse', kind: 'pulse', id: 'pulse', title: `$${(L.s.totalCost || 0).toFixed(2)} today`, eyebrow: 'Pulse',
      sub: `${Math.round(L.s.tokensPerSec || 0)} tok/s${L.usage ? ` · ${Math.round(L.usage.pct)}% of ${L.usage.label}` : ''}`,
      tps: L.tps, cost: L.s.totalCost || 0, usage: L.usage, working: L.c.working || 0, at: now, score: L.usage && L.usage.pct > 85 ? 60 : 20,
    });
    out.sort((x, y) => y.score - x.score || y.at - x.at);
    const byKey = Object.fromEntries(out.map((t) => [t.key, t]));
    // Anything a route can name, even if it's not in the list (an older doc,
    // a finished agent): built on demand.
    const lookup = (key) => {
      if (byKey[key]) return byKey[key];
      const [kind, ...rest] = String(key).split(':');
      const id = rest.join(':');
      if (kind === 'doc') {
        const d = L.docs.find((x) => x.id === id);
        return d ? { key, kind: 'doc', id, doc: d, title: d.title || id, eyebrow: d.kind || 'doc', at: toMs(d.updatedAt), score: 0 } : null;
      }
      if (kind === 'agent') {
        const a = L.agents.find((x) => x.id === id);
        if (!a) return null;
        const n = splitName(a);
        return { key, kind: 'agent', id, agent: a, title: n.what || n.proj, eyebrow: n.proj, sub: a.activity || '', status: agentStatus(a), tps: a.tokensPerSec || 0, cost: a.cost || 0, working: agentStatus(a) === 'working', at: now, score: 0 };
      }
      return null;
    };
    return { L, things: out, byKey, lookup };
  }, [L]);
}

export const KIND_LABEL = { need: 'Waiting on you', mia: 'Mia', agent: 'Agent', doc: 'Library', task: 'Task', pulse: 'Pulse' };
