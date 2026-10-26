import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, counts, agentStatus, agentName, isMiaAgent, attentionList, miaUnread, voiceText, miaAnswerFor } from '../../src/lib/store.js';
import { useUsage, worstWindow } from '../../src/lib/usage.js';

// v3 (task 0445): everything the three directions show, from v1's store —
// the same live snapshot v1 and v2 read, so the prototypes run on real data.

export const toMs = (at) => {
  if (!at) return 0;
  if (typeof at === 'number') return at > 1e12 ? at : at * 1000;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
};
export const hhmm = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
export const greeting = (h) => (h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : h >= 17 && h < 22 ? 'Good evening' : 'Good night');
export const ago = (ms, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const LIVE_TASK = new Set(['queued', 'asking', 'running', 'checking']);
const RECENT_MS = 60 * 60 * 1000;
export { agentName, voiceText, agentStatus };

export function useLive() {
  const { agents, summary, link, mia, local, docs, history, now } = useMC(
    useShallow((s) => ({ agents: s.agents, summary: s.summary, link: s.link, mia: s.mia, local: s.miaLocal, docs: s.docs, history: s.history, now: s.now })),
  );
  const usage = useUsage((s) => s.usage);
  return useMemo(() => {
    const c = counts(agents);
    const crew = agents.filter((a) => !isMiaAgent(a));
    const waiting = crew.filter((a) => agentStatus(a) === 'waiting');
    c.waiting = waiting.length;
    const all = attentionList(agents, mia);
    const items = all.filter((it) => it.kind !== 'mia' || !Number.isFinite(Date.parse(it.question?.askedAt || '')) || now - Date.parse(it.question.askedAt) <= RECENT_MS);
    const miaQs = items.filter((it) => it.kind === 'mia').length;
    let sentence;
    if (link === 'offline') sentence = 'Reconnecting to your Mac…';
    else if (link === 'relay') sentence = 'Your Mac is offline.';
    else if (miaQs && !c.waiting) sentence = `Mia has ${miaQs === 1 ? 'a question' : `${miaQs} questions`} for you.`;
    else if (c.working && items.length) sentence = `${plural(c.working, 'agent', 'agents')} working, ${plural(items.length, 'thing needs', 'things need')} you.`;
    else if (c.working) sentence = `${plural(c.working, 'agent', 'agents')} working. Nothing waiting on you.`;
    else if (items.length) sentence = `${plural(items.length, 'thing needs', 'things need')} you.`;
    else if (agents.length) sentence = 'All quiet. Nothing waiting on you.';
    else sentence = 'No agents running.';
    const ms = mia?.messages || [];
    let lastMia = null;
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i].from === 'mia' && ms[i].kind !== 'event' && ms[i].kind !== 'question' && ms[i].text) { lastMia = ms[i]; break; }
    const tasks = (mia?.tasks || []).filter((t) => LIVE_TASK.has(t.status));
    const doneTasks = (mia?.tasks || []).filter((t) => t.status === 'done');
    const recentDocs = [...(docs || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
    const tps = history.slice(-60).map((h) => h.tps || 0);
    // Mia is "thinking" when Daniel spoke last and she hasn't answered yet.
    const lastAny = [...ms].reverse().find((m) => m.kind !== 'event' && m.from !== 'system');
    const thinking = (local?.sent?.length || 0) > 0 || (lastAny && lastAny.from === 'daniel' && now - toMs(lastAny.at) < 5 * 60e3);
    return {
      link, agents, crew, c, items, sentence, mia, lastMia, tasks, doneTasks, docs: docs || [], recentDocs, tps,
      s: summary || {}, usage: worstWindow(usage, now || Date.now()), now: now || Date.now(),
      unread: mia ? miaUnread(mia, local) : 0, thinking: !!thinking, online: !!mia?.online,
    };
  }, [agents, summary, link, mia, local, docs, history, now, usage]);
}

// The conversation as rows: messages (answers to questions fold into their
// question), Daniel's not-yet-echoed sends as pending, day breaks.
export function useThread() {
  const mia = useMC((s) => s.mia);
  const local = useMC((s) => s.miaLocal);
  return useMemo(() => {
    if (!mia) return { rows: [], openIds: new Set(), mia: null, local };
    const openIds = new Set((mia.pendingQuestions || []).map((q) => q.questionId).filter((id) => id && !(id in local.answered) && !(id in (local.dismissed || {}))));
    const asked = new Set(mia.messages.filter((m) => m.kind === 'question' && m.questionId).map((m) => m.questionId));
    const rows = [];
    mia.messages.forEach((m, i) => {
      if (m.kind === 'answer' && m.questionId && asked.has(m.questionId)) return;
      const said = voiceText(m.text || '');
      rows.push({
        key: m.id || `i${i}`, m, ms: toMs(m.at), text: said.text, voice: said.voice,
        mine: m.from === 'daniel', event: m.from === 'system' || m.kind === 'event',
        open: m.kind === 'question' && openIds.has(m.questionId), answer: m.kind === 'question' ? miaAnswerFor(mia, m.questionId, local) : undefined,
      });
    });
    for (const p of local.sent) rows.push({ key: p.id, m: { from: 'daniel', kind: 'chat', text: p.text, at: p.at }, ms: toMs(p.at), text: voiceText(p.text).text, mine: true, pending: true });
    return { rows, openIds, mia, local };
  }, [mia, local]);
}

// Short human names for agents ("crystal-garden · daily harvest" → both parts).
export function splitName(a) {
  const n = agentName(a) || '';
  const [proj, what] = n.split(' · ');
  return { proj: proj || a.folder || n, what: what || a.prompt || a.activity || '' };
}
