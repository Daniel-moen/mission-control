// `npm run build` in remote/web (also run by remote's `postbuild`):
// Next static export → ../dist/v6.html + ../dist/v6/{_next,manifest.json,…}.
// The relay serves /v6 → dist/v6.html and the rest as plain files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUILD = process.env.MC_BUILD || `v6-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
const env = { ...process.env, MC_BUILD: BUILD, NEXT_TELEMETRY_DISABLED: '1' };
execFileSync(path.join(ROOT, 'node_modules', '.bin', 'next'), ['build'], { cwd: ROOT, env, stdio: 'inherit' });

const out = path.join(ROOT, 'out');
const dist = path.join(ROOT, '..', 'dist');
const target = path.join(dist, 'v6');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(out, target, { recursive: true });
fs.renameSync(path.join(target, 'index.html'), path.join(dist, 'v6.html'));
fs.writeFileSync(path.join(target, 'version.json'), JSON.stringify({ build: BUILD }));
console.log(`v6 → dist/v6.html + dist/v6/ (build ${BUILD})`);
