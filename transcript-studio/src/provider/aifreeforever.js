/**
 * provider/aifreeforever.js — one browser, many jobs.
 *
 * The page driver is expensive to start (Chrome, the security check) and cheap to
 * reuse (a navigation, two seconds), so a provider instance holds one page for the
 * life of the process. The local server is one long-lived process, which is
 * exactly the shape this wants; the CLI creates one, runs one job, and closes it.
 */

import { FreeTranscriberPage } from '../browser/aifreeforever.js';

export const PROVIDER_NAME = 'aifreeforever';

export class FreeTranscriber {
  constructor({ chromePath = null, profileDir = null, onLog = null, page = null, timeoutMs = 600000 } = {}) {
    this.chromePath = chromePath;
    this.profileDir = profileDir;
    this.onLog = onLog;
    this.timeoutMs = timeoutMs;
    this.page = page;
  }

  /** Created on first use, so `--help` and a bad file never launch Chrome. */
  ensurePage() {
    if (!this.page) {
      this.page = new FreeTranscriberPage({
        chromePath: this.chromePath,
        profileDir: this.profileDir,
        onLog: this.onLog,
      });
    }
    return this.page;
  }

  async transcribe({ filePath, fileName = null, language = 'auto', onProgress = null }) {
    return this.ensurePage().transcribe({
      filePath,
      fileName,
      language,
      onProgress,
      timeoutMs: this.timeoutMs,
    });
  }

  async close() {
    await this.page?.close();
    this.page = null;
  }
}
