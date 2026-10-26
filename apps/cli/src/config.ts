/** 个人 CLI 的本机配置与凭据；所有服务器地址先规范化，再用于网络请求。 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const DEFAULT_SERVER = 'http://127.0.0.1:3333';

export function cliDir(): string {
  const override = process.env.YUXU_CLI_DIR ?? process.env.PLATFORM_CLI_DIR;
  if (override) return resolve(override);
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return resolve(configHome, 'yuxu');
}

function configFile(): string { return join(cliDir(), 'config.json'); }
function credentialFile(server: string): string {
  // 服务器 origin 不进入文件名；每台服务器的令牌独立保存，可随时切换。
  const key = createHash('sha256').update(server).digest('hex');
  return join(cliDir(), 'credentials', `${key}.json`);
}

/** 远端仅允许 HTTPS；本机回环地址可用 HTTP。禁止在 URL 中夹带凭据或路径。 */
export function normalizeServer(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('服务器地址无效，应为完整的 HTTP 或 HTTPS 根地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('本机回环地址可使用 HTTP；其他服务器必须使用 HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('服务器地址只能是根地址，不能包含路径、查询参数或凭据');
  }
  return url.origin;
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 首次升级时按需迁移旧 platform-cli 配置和对应服务器凭据。
      const configHome = resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
      const currentDir = resolve(configHome, 'yuxu');
      if (resolve(cliDir()) === currentDir) {
        const localPath = relative(currentDir, path);
        if (localPath && !localPath.startsWith('..') && !isAbsolute(localPath)) {
          const previousPath = join(configHome, 'platform-cli', localPath);
          try {
            const previous = await readFile(previousPath, 'utf8');
            await writePrivate(path, previous);
            await rm(previousPath, { force: true });
            return previous;
          } catch (migrationError) {
            if ((migrationError as NodeJS.ErrnoException).code !== 'ENOENT') throw migrationError;
          }
        }
      }
      return null;
    }
    throw error;
  }
}

/** 配置和令牌以临时文件原子替换，文件权限为仅当前用户可读写。 */
async function writePrivate(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(cliDir(), { recursive: true, mode: 0o700 });
  await chmod(cliDir(), 0o700);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (directory !== cliDir()) await chmod(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function configuredServer(): Promise<string | null> {
  const content = await readOptional(configFile());
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content) as { server?: unknown };
    if (typeof parsed.server !== 'string') throw new Error('invalid');
    return normalizeServer(parsed.server);
  } catch { throw new Error('CLI 配置文件无效，请重新运行 config set-server'); }
}

/** 命令参数优先于环境变量，环境变量优先于本地配置。 */
export async function resolveServer(explicit?: string): Promise<{ server: string; source: string }> {
  if (explicit) return { server: normalizeServer(explicit), source: '--server' };
  if (process.env.PLATFORM_URL) return { server: normalizeServer(process.env.PLATFORM_URL), source: 'PLATFORM_URL' };
  const saved = await configuredServer();
  return saved ? { server: saved, source: 'config' } : { server: DEFAULT_SERVER, source: 'default' };
}

export async function saveServer(value: string): Promise<string> {
  const server = normalizeServer(value);
  await writePrivate(configFile(), `${JSON.stringify({ server }, null, 2)}\n`);
  return server;
}

/** 环境变量令牌是显式覆盖；持久化令牌必须匹配当前服务器 origin。 */
export async function readToken(server: string): Promise<string> {
  if (process.env.PLATFORM_TOKEN) return process.env.PLATFORM_TOKEN;
  const content = await readOptional(credentialFile(server));
  if (content === null) throw new Error('尚未登录，请运行 yuxu login');
  let saved: { server?: unknown; token?: unknown };
  try { saved = JSON.parse(content) as typeof saved; }
  catch { throw new Error('CLI 凭据文件无效，请重新登录'); }
  if (saved.server !== server) throw new Error('CLI 凭据服务器校验失败，请重新登录');
  if (typeof saved.token !== 'string' || saved.token.length === 0) {
    throw new Error('CLI 凭据文件无效，请重新登录');
  }
  return saved.token;
}

export async function saveToken(server: string, token: string): Promise<void> {
  await writePrivate(credentialFile(server), JSON.stringify({ server, token }));
}

/** 仅删除本机令牌；服务端令牌撤销接口尚未实现。 */
export async function forgetToken(server?: string): Promise<void> {
  if (server) await rm(credentialFile(server), { force: true });
  else await rm(join(cliDir(), 'credentials'), { recursive: true, force: true });
}
