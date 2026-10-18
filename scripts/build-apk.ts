import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { nativeConfig, root } from './config.ts';

const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : Bun.which('java');
if (!java || !existsSync(java)) throw new Error('APK builds require JDK 21 (set JAVA_HOME)');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk || !existsSync(join(sdk, 'platforms/android-36'))) throw new Error('Install Android SDK platform 36 and set ANDROID_HOME');
if (!existsSync(join(sdk, 'ndk', process.env.JITPACK_NDK_VERSION ?? '29.0.14206865'))) throw new Error('Install/select the APK NDK');
const workspace = join(root, 'build/android/termux-app');
const directory = resolve(process.env.MUSHI_BOOTSTRAP_DIR ?? join(root, 'build/prebuilt/bootstraps'));
const architectures = (process.env.MUSHI_ARCHITECTURES ?? 'aarch64').split(',');
if (!architectures.length || architectures.some(arch => !Object.hasOwn(nativeConfig.architectures, arch))) throw new Error('Invalid MUSHI_ARCHITECTURES');
const env = { ...process.env, MUSHI_BOOTSTRAP_DIR: directory, MUSHI_ARCHITECTURES: architectures.join(',') };
async function run(command: string[], cwd = root) {
  const child = Bun.spawn(command, { cwd, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`Failed: ${command.join(' ')}`);
}
for (const architecture of architectures) {
  if (!existsSync(join(directory, `bootstrap-${architecture}.zip`))) {
    if (process.env.MUSHI_BOOTSTRAP_DIR) throw new Error(`Missing ${architecture} bootstrap in supplied MUSHI_BOOTSTRAP_DIR`);
    await run([process.execPath, 'scripts/build-runtime.ts', '--arch', architecture]);
  }
}
await run(['python3', 'scripts/prepare-bootstraps.py', '--destination', join(root, 'build/prebuilt/staged')]);
await run([process.execPath, 'scripts/bundle.ts']);
await run(['python3', 'scripts/prepare-android.py']);
const aapt2 = process.env.MUSHI_AAPT2 ? resolve(process.env.MUSHI_AAPT2) : undefined;
await run(['./gradlew', '--no-daemon', '--max-workers=2', ...(aapt2 ? [`-Pandroid.aapt2FromMavenOverride=${aapt2}`] : []), 'assembleDebug'], workspace);
for await (const file of new Bun.Glob('*.apk').scan(join(workspace, 'app/build/outputs/apk/debug'))) {
  await run(['python3', 'scripts/verify-apk-runtime.py', '--apk', join(workspace, 'app/build/outputs/apk/debug', file), '--bootstraps', directory]);
}
