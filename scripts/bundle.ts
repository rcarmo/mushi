import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { bundleCodemodeAssets } from './codemode-assets.ts';
const out = 'build/assets/mushi';
await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: ['agent/server.ts'], outdir: out,
  naming: 'agent.mjs', target: 'bun', format: 'esm', minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Agent bundle failed');
await bundleCodemodeAssets(out);
const ui = await Bun.build({ entrypoints: ['web/app.js'], outdir: out, naming: 'app.js', target: 'browser', format: 'iife', minify: true });
if (!ui.success) throw new AggregateError(ui.logs, 'UI bundle failed');
for (const name of ['index.html', 'style.css', 'mushi.svg']) await copyFile(`web/${name}`, `${out}/${name}`);
await copyFile('android/start-agent.sh', `${out}/start-agent.sh`);
const notices = [await readFile('NOTICE.md', 'utf8'), await readFile('licenses/pi-MIT.txt', 'utf8'),
  await readFile('licenses/Apache-2.0.txt', 'utf8'), await readFile('licenses/kintsugi-MIT.txt', 'utf8'),
  await readFile('vendor/termux-packages/LICENSE.md', 'utf8')];
for await (const path of new Bun.Glob('node_modules/**/{LICENSE,LICENSE.*,license,license.*,NOTICE,NOTICE.*}').scan('.')) {
  notices.push(`\n===== ${path} =====\n${await readFile(path, 'utf8')}`);
}
notices.push(await readFile('LICENSE', 'utf8'));
await writeFile(`${out}/THIRD_PARTY_LICENSES.txt`, notices.join('\n'));
console.log(`Bundled agent and UI → ${out}`);
