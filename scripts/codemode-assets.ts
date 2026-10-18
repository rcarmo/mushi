import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function bundleCodemodeAssets(out: string) {
  await mkdir(out, { recursive: true });
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../agent/codemode-worker.ts', import.meta.url))],
    outdir: out, naming: 'codemode-worker.mjs', target: 'bun', format: 'esm', minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, 'Codemode worker bundle failed');
  await copyFile(fileURLToPath(import.meta.resolve('quickjs-wasi/quickjs.wasm')), `${out}/quickjs.wasm`);
}
