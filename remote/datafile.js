// Where the relay keeps a small JSON store.
//
// On Railway the container disk is wiped by every deploy; the volume at
// RAILWAY_VOLUME_MOUNT_PATH (/data) is not. An explicit override (PUSH_STORE,
// TTS_STORE, …) wins; otherwise the file lives on the volume when there is one,
// else in the working directory. If the volume copy doesn't exist yet but the
// old working-directory file does, that file is moved over once.

'use strict';

const fs = require('fs');
const path = require('path');

function dataFile(name, { override, env = process.env, log = console, tag = 'store' } = {}) {
  if (override) return path.resolve(override);
  const legacy = path.resolve(name);
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH || '';
  if (!volume) return legacy;
  const target = path.resolve(volume, name);
  if (target !== legacy && !fs.existsSync(target) && fs.existsSync(legacy)) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(legacy, target);
      try { fs.unlinkSync(legacy); } catch {}
      log.log(`${tag}: moved ${legacy} to ${target}`);
    } catch (e) {
      log.warn(`${tag}: could not move ${legacy} to ${target}: ${e.message}`);
    }
  }
  return target;
}

module.exports = { dataFile };
