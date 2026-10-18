import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

const copy = <T>(value: T): T => structuredClone(value);
function validateProvider(id: string) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid credential provider');
}
function validateCredential(value: unknown): asserts value is Credential {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored credential');
  const c = value as Credential;
  if (c.type === 'api_key') {
    if (typeof c.key !== 'string' || !c.key.trim() || /[\u0000-\u001f\u007f]/.test(c.key)) throw new Error('Invalid API-key credential');
  } else if (c.type === 'oauth') {
    if (typeof c.access !== 'string' || !c.access || typeof c.refresh !== 'string' || !c.refresh || !Number.isFinite(c.expires) ||
        /[\u0000-\u001f\u007f]/.test(c.access) || /[\u0000-\u001f\u007f]/.test(c.refresh)) throw new Error('Invalid OAuth credential');
  } else throw new Error('Unknown credential type');
}

/** One agent process owns this file under start-agent.sh's lifetime flock.
 * A global mutation queue prevents refresh/login/logout and cross-provider writes
 * from clobbering one another. Never expose read()/modify() results to the UI.
 */
export class FileCredentialStore implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private file: string, private entries: Map<string, Credential>) {}

  static async open(file: string) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const entries = new Map<string, Credential>();
    try {
      const text = await readFile(file, 'utf8');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Invalid credentials file JSON'); }
      if (data?.version !== 1 || !data.credentials || typeof data.credentials !== 'object' || Array.isArray(data.credentials)) throw new Error('Invalid credentials file format');
      for (const [id, value] of Object.entries(data.credentials)) {
        validateProvider(id); validateCredential(value); entries.set(id, value);
      }
      await chmod(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new FileCredentialStore(file, entries);
  }

  async read(id: string, options?: AuthOperationOptions) {
    validateProvider(id); options?.signal?.throwIfAborted();
    const value = this.entries.get(id);
    return value === undefined ? undefined : copy(value);
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return [...this.entries].map(([providerId, value]) => ({ providerId, type: value.type }));
  }
  private enqueue<T>(options: AuthOperationOptions | undefined, task: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => { options?.signal?.throwIfAborted(); return task(); });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
  private async save(next: Map<string, Credential>) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, credentials: Object.fromEntries(next) }));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.file);
      // Rename is the commit boundary; never revert a rotated refresh token.
      this.entries = next;
      const directory = await open(dirname(this.file), 'r');
      try { await directory.sync(); }
      catch (error) { if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    validateProvider(id);
    return this.enqueue(options, async () => {
      const current = this.entries.get(id);
      const updated = await fn(current === undefined ? undefined : copy(current));
      // Cancellation after a mutation starts must not lose a rotated token.
      // pi-ai removes its lock-wait abort listener before refresh begins.
      if (updated !== undefined) {
        validateCredential(updated);
        const next = new Map(this.entries);
        next.set(id, JSON.parse(JSON.stringify(updated)));
        await this.save(next);
      }
      const result = this.entries.get(id);
      return result === undefined ? undefined : copy(result);
    });
  }
  async flush() { await this.tail; }
  delete(id: string, options?: AuthOperationOptions) {
    validateProvider(id);
    return this.enqueue(options, async () => {
      if (!this.entries.has(id)) return;
      const next = new Map(this.entries); next.delete(id); await this.save(next);
    });
  }
}
