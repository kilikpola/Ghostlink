/**
 * Shared by ratchet-store-test.js and its child processes (task R5).
 *
 * fileAnchor(): a stand-in for OS secure storage (Electron safeStorage in R7).
 * It lives OUTSIDE the store directory, so restoring the store's files does
 * not restore it — the property rollback detection rests on. File-backed so
 * child processes share it; `status` simulates a locked / insecure keyring.
 */
import fs from 'fs';
import path from 'path';

export function fileAnchor(file, { status = 'ok', failSaves = false } = {}) {
  const box = { status, failSaves, saves: 0, loads: 0 };
  return {
    box,
    provider: {
      load() {
        box.loads++;
        if (box.status !== 'ok') return { status: box.status, detail: `test keyring is ${box.status}` };
        if (!fs.existsSync(file)) return { status: 'absent' };
        return { status: 'ok', anchor: JSON.parse(fs.readFileSync(file, 'utf8')) };
      },
      save(anchor) {
        if (box.status !== 'ok' || box.failSaves) throw new Error(`test keyring refused the write (${box.status}${box.failSaves ? ', failSaves' : ''})`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(anchor));
        fs.renameSync(tmp, file);
        box.saves++;
      },
    },
  };
}

/** Append one line durably (the record must survive a SIGKILL right after). */
export function appendDurable(file, line) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
