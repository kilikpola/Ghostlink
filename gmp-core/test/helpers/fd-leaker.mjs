/**
 * Preloaded (--import) into a node process by fd-pressure-test: after
 * FD_LEAK_DELAY_MS, opens /dev/null FD_LEAK_STEP at a time every 100 ms until
 * FD_LEAK_TOTAL are held — descriptors no connection explains, as a leak
 * elsewhere in the process would hold them.
 */
import fs from 'fs';
const total = Number(process.env.FD_LEAK_TOTAL || 0);
const step = Number(process.env.FD_LEAK_STEP || 4);
const held = [];
if (total > 0) {
  setTimeout(() => {
    const t = setInterval(() => {
      for (let i = 0; i < step && held.length < total; i++) {
        try { held.push(fs.openSync('/dev/null', 'r')); } catch { held.length = total; }
      }
      if (held.length >= total) clearInterval(t);
    }, 100);
    t.unref();
  }, Number(process.env.FD_LEAK_DELAY_MS || 1500)).unref();
}
