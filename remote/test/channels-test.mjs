// Mia's iMessage channel — unit checks for the launch flags and the session
// settings that replace --strict-mcp-config (docs/mia.md §11).
//
//   node test/channels-test.mjs            # pure rules
//   CHANNELS_REAL_HOME=~ node test/channels-test.mjs   # + resolve on this Mac
//
// Builds Sources/AgentWidget/MiaChannels.swift with test/mac-channels/main.swift.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-channels-'));

console.log('MiaChannels.swift');
const bin = path.join(TMP, 'channels-harness');
execFileSync('swiftc', [path.join(ROOT, 'Sources/AgentWidget/MiaChannels.swift'), path.join(DIR, 'mac-channels/main.swift'), '-o', bin], { stdio: 'inherit' });
const sw = spawnSync(bin, { encoding: 'utf8', env: process.env });
process.stdout.write(sw.stdout);
process.stderr.write(sw.stderr);
const passed = (sw.stdout.match(/✓/g) || []).length;
const failed = (sw.stdout.match(/✗/g) || []).length + (sw.status === 0 ? 0 : 1);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed ? failed : 0} failed`);
process.exit(sw.status === 0 && !failed ? 0 : 1);
