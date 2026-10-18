import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CodemodeSandbox, loadQuickJSWasm, type CodemodeRunOptions } from '@earendil-works/pi-codemode';

class AgentSandbox extends CodemodeSandbox {
  override start(code: string, options: CodemodeRunOptions) {
    // Durable start() has no default deadline, unlike execute(). Bound runaway
    // scripts even when the model omits an @options timeout.
    return super.start(code, { ...options, timeoutMs: options.timeoutMs ?? 300_000 });
  }
}

/** Both APK and smoke bundles ship these siblings; source tests use installed packages. */
export function createAgentSandbox() {
  const wasm = new URL('./quickjs.wasm', import.meta.url);
  const bundled = existsSync(wasm);
  let workers = 0;
  return new AgentSandbox({
    wasm: loadQuickJSWasm(bundled ? fileURLToPath(wasm) : undefined),
    workerUrl: bundled ? new URL('./codemode-worker.mjs', import.meta.url) : new URL(import.meta.resolve('@earendil-works/pi-codemode/worker')),
    memoryLimitBytes: 128 * 1024 * 1024,
    acquireWorker() {
      if (workers >= 4) throw new Error('Too many active scripts; wait for an earlier script to finish');
      workers++;
      return () => { workers--; };
    },
  });
}
