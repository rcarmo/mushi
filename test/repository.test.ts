import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const dependencies = [
  { name: 'termux-app', revision: '8629e632fcb95da272221be327db653fb24befe9' },
  { name: 'termux-packages', revision: 'ae877f2c6a2b2318abeb43699d6ec5f619c216a6' },
];

for (const { name, revision } of dependencies) {
  test(`${name} is an exact-commit Git submodule, not copied source`, () => {
    const path = `vendor/${name}`;
    const index = Bun.spawnSync(['git', 'ls-files', '--stage', '--', path]);
    expect(index.exitCode).toBe(0);
    expect(index.stdout.toString().trim()).toBe(`160000 ${revision} 0\t${path}`);
    const head = Bun.spawnSync(['git', '-C', path, 'rev-parse', 'HEAD']);
    expect(head.exitCode).toBe(0);
    expect(head.stdout.toString().trim()).toBe(revision);
    const url = Bun.spawnSync(['git', 'config', '-f', '.gitmodules', '--get', `submodule.${path}.url`]);
    expect(url.exitCode).toBe(0);
    expect(url.stdout.toString().trim()).toBe(`https://github.com/termux/${name}.git`);
    if (name === 'termux-app') {
      expect(readFileSync('scripts/prepare-android.py', 'utf8')).toContain(`expected = '${revision}'`);
    } else {
      expect(JSON.parse(readFileSync('native/build-config.json', 'utf8')).packagesRevision).toBe(revision);
    }
  });
}
