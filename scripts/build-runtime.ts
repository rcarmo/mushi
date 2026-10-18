import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nativeConfig, root } from './config.ts';

const args = process.argv.slice(2).filter(a => a !== '--');
let arch = 'aarch64', fetchOnly = false, refresh = false, testing = false;
let ndk = process.env.MUSHI_RUNTIME_NDK ?? process.env.NDK;
while (args.length) {
  const arg = args.shift();
  if (arg === '--arch') arch = args.shift() ?? '';
  else if (arg === '--fetch-only') fetchOnly = true;
  else if (arg === '--refresh-lock') refresh = true;
  else if (arg === '--testing-libs') testing = true;
  else if (arg === '--ndk') ndk = args.shift();
  else throw new Error(`Unknown runtime argument: ${arg}`);
}
if (!Object.hasOwn(nativeConfig.architectures, arch)) throw new Error('Unsupported runtime architecture');
async function run(command: string[], env = process.env) {
  const child = Bun.spawn(command, { cwd: root, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Failed: ${command.join(' ')}`);
}
await run(['python3', 'native/prebuilt-runtime.py', '--arch', arch, ...(refresh ? ['--refresh-lock'] : []), ...(testing ? ['--testing-libs'] : [])]);
if (!fetchOnly) {
  if (!ndk) {
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    const directory = sdk && join(sdk, 'ndk');
    if (directory && existsSync(directory)) {
      const selected = process.env.JITPACK_NDK_VERSION ?? readdirSync(directory).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      if (selected) ndk = join(directory, selected);
    }
  }
  if (!ndk) throw new Error('Set NDK/MUSHI_RUNTIME_NDK for the tiny exec-path bridge, or use --fetch-only. No userland source build is needed.');
  await run(['python3', 'native/assemble-prebuilt.py', '--arch', arch, '--ndk', resolve(ndk), '--offline']);
  await run(['python3', 'scripts/prepare-bootstraps.py', '--destination', 'build/prebuilt/staged'],
    { ...process.env, MUSHI_BOOTSTRAP_DIR: join(root, 'build/prebuilt/bootstraps'), MUSHI_ARCHITECTURES: arch });
}
