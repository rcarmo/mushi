// Host-side integration runner. Bun builds/drives tests; only the Android target
// Bun executes agent code. /system and the test prefix must be explicitly set up.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { root } from './config.ts';
import { bundleCodemodeAssets } from './codemode-assets.ts';

if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('Native Android/Bionic smoke test requires an ARM64 Linux host; no QEMU fallback');
const prefix = '/data/data/io.carmo.mushi/files/usr';
const runtime = join(root, 'build/prebuilt/aarch64/assembled/data/data/com.termux/files/usr');
if (realpathSync(prefix) !== realpathSync(runtime)) throw new Error('The explicit host test prefix must point at the assembled prebuilt candidate; see README.md');
const binary = await Bun.file(join(prefix, 'bin/bun')).bytes();
if (binary[18] !== 183 || binary[19] !== 0) throw new Error('Smoke target is not AArch64 ELF');
const home = '/data/data/io.carmo.mushi/files/home';
await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(join(prefix, 'tmp'), { recursive: true, mode: 0o700 });
const output = join(root, 'build/prebuilt/aarch64');
await bundleCodemodeAssets(output);
const bundle = await Bun.build({ entrypoints: [join(root, 'test/android-prebuilt-smoke.ts')], target: 'bun', format: 'esm', outdir: output, naming: 'android-smoke.mjs' });
const recoveryBundle = await Bun.build({ entrypoints: [join(root, 'test/android-bun-recovery.ts')], target: 'bun', format: 'esm', outdir: output, naming: 'android-bun-recovery.mjs' });
if (!recoveryBundle.success) throw new AggregateError(recoveryBundle.logs, 'Bun recovery fixture bundle failed');
if (!bundle.success) throw new AggregateError(bundle.logs, 'Android smoke bundle failed');
const env: Record<string, string> = {
  PREFIX: prefix, HOME: home, PATH: `${prefix}/bin:/system/bin`, TMPDIR: `${prefix}/tmp`,
  LD_LIBRARY_PATH: `${prefix}/lib:/system/lib64`, LD_PRELOAD: `${prefix}/lib/libmushi-exec.so`,
  ANDROID_ROOT: '/system', ANDROID_DATA: '/data', LANG: 'C.UTF-8', MUSHI_TEST_SYSTEM_LIBS: '/system/lib64',
  MUSHI_SMOKE_HTTPS: process.argv.includes('--https') ? '1' : '0',
};
function spawn(entry: string, extra: Record<string, string> = {}) {
  return Bun.spawn([`${prefix}/bin/bash`, '--noprofile', '--norc', '-c', '. "$PREFIX/etc/mushi/environment.sh"; exec "$PREFIX/bin/bun" "$1"', 'mushi-smoke', entry],
    { env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
}
const child = spawn(join(output, 'android-smoke.mjs'));
const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
const code = await child.exited;
await Bun.write(join(output, 'android-smoke.log'), await stderr + await stdout);
if (code) throw new Error(`Android runtime smoke failed (${code}); see ${output}/android-smoke.log`);
const result = JSON.parse((await stdout).trim().split('\n').at(-1)!);
if (!result.ok || result.platform !== 'android' || result.engine !== 'bun') throw new Error('No native Android/Bun smoke receipt');
const recoveryDirectory = await mkdtemp(join(home, '.mushi-recovery-smoke-'));
let recovery;
try {
  const first = spawn(join(output, 'android-bun-recovery.mjs'), { MUSHI_RECOVERY_DIRECTORY: recoveryDirectory, MUSHI_RECOVERY_PHASE: 'admit' });
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { await stat(join(recoveryDirectory, 'effects.txt')); ready = true; break; } catch { }
      if (first.exitCode !== null) throw new Error(await new Response(first.stderr).text());
      await Bun.sleep(25);
    }
    if (!ready) throw new Error('Bun recovery worker did not commit its unsafe effect intent');
  } finally { first.kill('SIGKILL'); await first.exited; }
  const resumed = spawn(join(output, 'android-bun-recovery.mjs'), { MUSHI_RECOVERY_DIRECTORY: recoveryDirectory, MUSHI_RECOVERY_PHASE: 'resume' });
  const text = new Response(resumed.stdout).text(), error = new Response(resumed.stderr).text();
  const deadline = setTimeout(() => resumed.kill('SIGKILL'), 10000);
  const resumedCode = await resumed.exited; clearTimeout(deadline);
  if (resumedCode !== 0) throw new Error(`Bun recovery worker failed/timed out: ${await error}`);
  recovery = JSON.parse((await text).trim().split('\n').at(-1)!);
} finally { await rm(recoveryDirectory, { recursive: true, force: true }); }

function call(socketPath: string, path: string, body?: object) {
  return new Promise<any>((resolve, reject) => {
    const req = request({ socketPath, path, method: body ? 'POST' : 'GET' }, res => {
      let text = ''; res.on('data', data => { text += data; });
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error(text); resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('Socket smoke timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const directory = await mkdtemp(join(home, '.mushi-server-smoke-'));
const server = spawn(join(root, 'build/assets/mushi/agent.mjs'), { MUSHI_HOME: directory });
const serverOut = new Response(server.stdout).text(), serverErr = new Response(server.stderr).text();
const socket = join(directory, 'agent.sock');
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if (((await stat(socket)).mode & 0o777) === 0o600) { ready = true; break; } } catch { }
    if (server.exitCode !== null) throw new Error(await serverErr);
    await Bun.sleep(50);
  }
  if (!ready) throw new Error('Native Android server did not bind its private socket');
  const state = await call(socket, '/api/state');
  if (state.runtime?.engine !== 'bun' || !state.runtime.version) throw new Error('Daemon is not running on Bun');
  if (state.configured !== false) throw new Error('Unexpected smoke provider configuration');
  const models = await call(socket, '/api/models');
  if (!models.some((model: any) => model.provider === 'anthropic')) throw new Error('Provider catalog unavailable on Android');
  const auth = await call(socket, '/api/auth');
  if (auth.providers.length !== 4 || auth.providers.some((provider: any) => provider.connected)) throw new Error('Unexpected Android authentication status');
  const openai = models.find((model: any) => model.provider === 'openai');
  await call(socket, '/api/config', { provider: 'openai', modelId: openai.modelId, apiKey: 'smoke-only-not-a-real-key' });
  if (!(await call(socket, '/api/state')).configured) throw new Error('Android API-key credential save failed');
  await call(socket, '/api/auth/logout', { provider: 'openai' });
  if ((await call(socket, '/api/state')).configured) throw new Error('Android credential logout failed');
  await call(socket, '/api/shutdown', {});
  if (await server.exited !== 0) throw new Error('Native Android server shutdown failed');
  const archive = Bun.file(join(root, 'build/prebuilt/bootstraps/bootstrap-aarch64.zip'));
  const receipt = { ...result, recovery, privateSocket: true, host: 'Linux ARM64 with prebuilt Bionic', androidDeviceVerified: false,
    bootstrapSha256: new Bun.CryptoHasher('sha256').update(await archive.arrayBuffer()).digest('hex') };
  await Bun.write(join(output, 'smoke-proof.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (server.exitCode === null) server.kill();
  await server.exited;
  await Bun.write(join(output, 'server-smoke.log'), await serverErr + await serverOut);
  await rm(directory, { recursive: true, force: true });
}
