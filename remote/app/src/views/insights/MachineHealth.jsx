import { useShallow } from 'zustand/react/shallow';
import { useMC, fmtMem } from '../../lib/store.js';
import Meter from '../../ui/Meter.jsx';
import { Section, Head } from './parts.jsx';

// What the fleet is doing to the Mac. Host CPU/MEM come straight from the
// snapshot's `system` block; the two "Agents" rows are the fleet's own
// processes summed from per-agent cpu/mem. Both are NEW host fields — an older
// Mac app sends neither, so every row is conditional and the card degrades to
// a one-line explanation rather than a wall of zeroes.
export default function MachineHealth() {
  const system = useMC((s) => s.system);
  const load = useMC(
    useShallow((s) => {
      let cpu = 0;
      let mem = 0;
      let n = 0;
      for (const a of s.agents) {
        if (typeof a.cpu === 'number') {
          cpu += a.cpu;
          n++;
        }
        if (typeof a.mem === 'number') mem += a.mem;
      }
      return n ? { cpu, mem, n } : null;
    }),
  );

  const bars = [];
  if (system) {
    bars.push({ label: 'Host CPU', value: (system.cpu ?? 0) / 100, sub: `${system.cores ?? '—'} cores` });
    if (system.memTotalMB) {
      bars.push({
        label: 'Host memory',
        value: (system.memUsedMB ?? 0) / system.memTotalMB,
        sub: `${fmtMem(system.memUsedMB)} of ${fmtMem(system.memTotalMB)}`,
      });
    }
  }
  if (load) {
    // Per-process CPU is percent-of-one-core, so 600 % across 12 cores is half
    // the machine — divide by the core count when the host tells us what it is.
    bars.push({
      label: 'Agents CPU',
      value: (system?.cores ? load.cpu / system.cores : load.cpu) / 100,
      sub: `${load.cpu.toFixed(0)}% across ${load.n} proc${load.n === 1 ? '' : 's'}`,
    });
    if (system?.memTotalMB) {
      bars.push({ label: 'Agents memory', value: load.mem / system.memTotalMB, sub: fmtMem(load.mem) });
    }
  }

  return (
    <Section className="flex flex-col p-4 sm:p-5">
      <Head title="Machine health" />
      {bars.length ? (
        <div className="mt-4 flex flex-1 flex-col justify-center gap-4">
          {bars.map((b) => (
            <Meter key={b.label} value={b.value} label={b.label} sub={b.sub} />
          ))}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center py-10 text-center">
          <span className="max-w-[26ch] text-[12.5px] leading-relaxed text-ink3">
            No host telemetry — this Mac app is older than the CPU/memory feed.
          </span>
        </div>
      )}
    </Section>
  );
}
