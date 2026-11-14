/** 使用本机 Chrome 和临时数据库验证真实页面；不访问线上服务。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.ts';
import { createPlatformServer } from '../src/server.ts';
import { PodcastStore } from '../src/podcast/store.ts';
import { podcastManifest } from '../src/podcast/manifest.ts';
import { TranscriptionQueueStore } from '../src/transcription/queue.ts';
import { TranscriptionStore } from '../src/transcription/store.ts';
import { transcriptionManifest } from '../src/transcription/manifest.ts';
import { createWebServer } from '../web/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'taskbase-browser-'));
const database = join(directory, 'taskbase.sqlite');
const password = 'local-smoke-password-only';
const store = new Store(database);
store.bootstrap('owner', password);
store.upsertApp(podcastManifest);
store.upsertApp(transcriptionManifest);
store.markWorkerSeen('transcription-tools');
const podcasts = new PodcastStore(database);
const queue = new TranscriptionQueueStore(database);
const transcripts = new TranscriptionStore(database);
let firstShow = '';
let transcriptEpisode = '';
for (let i = 0; i < 54; i++) {
  const show = podcasts.addShow({ url: `https://example.com/show-${i}`, title: `测试节目 ${i}` });
  if (i < 27) podcasts.markSync(show.show_id, { status: 'succeeded' });
  if (i !== 0) continue;
  firstShow = show.show_id;
  podcasts.upsertEpisodes(show.show_id, Array.from({ length: 65 }, (_, n) => ({
    sourceId: `episode-${n}`, title: `测试单集 ${n}`, description: null,
    publishedAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(), durationSeconds: 60,
    audioUrl: `https://example.com/${n}.mp3`, imageUrl: null,
  })));
  const episodes = podcasts.listEpisodes(show.show_id);
  transcriptEpisode = episodes[0]!.episode_id;
  queue.add(episodes.map((episode) => ({ ...episode, audio_url: episode.audio_url! })));
  for (const [n, episode] of episodes.slice(0, 25).entries()) transcripts.save({
    taskId: `transcript-task-${n}`, episodeId: episode.episode_id, showId: show.show_id,
    title: episode.title, language: 'zh', provider: 'test', model: '', durationSeconds: 60,
    text: '浏览器检查转写内容', segments: [{ start: 0, end: 60, text: '测试' }], artifactId: null,
  });
  transcripts.save({ taskId: 'speaker-task', episodeId: transcriptEpisode, showId: show.show_id,
    title: '浏览器双人转写', language: 'zh', provider: 'whisper-cli', model: 'small', durationSeconds: 60,
    version: 2, diarization: { provider: 'pyannote', model: 'fixture' }, text: '你好 世界', segments: [
      { start: 0, end: 30, text: '你好 <script>alert(1)</script>', speaker_id: 'speaker_1' },
      { start: 30, end: 60, text: ' 世界', speaker_id: 'speaker_2' }], artifactId: null });
}
for (let i = 0; i < 55; i++) store.createTask('owner', 'podcast-tools', 'show/sync', { show_id: firstShow });
queue.close(); transcripts.close(); podcasts.close();
const platform = createPlatformServer(store, { artifactDir: join(directory, 'artifacts'), requestLog: () => {},
  sweepMs: 1_000_000, schedulerMs: 1_000_000 });
await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve));
const web = createWebServer({ platformUrl: `http://127.0.0.1:${(platform.address() as AddressInfo).port}`,
  dbPath: database, requestLog: () => {} });
await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
const webUrl = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
const chromePath = process.env.CHROME_PATH ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const profile = join(directory, 'chrome');
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', 'about:blank'],
{ stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError = '';
chrome.stderr.on('data', (data: Buffer) => { chromeError = (chromeError + data.toString()).slice(-2000); });
chrome.on('error', (error) => { chromeError = error.message; });
let socket: WebSocket | undefined;
let send: ((method: string, params?: Record<string, unknown>, session?: string) => Promise<any>) | undefined;
try {
  let portFile = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    try { portFile = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); break; }
    catch { await delay(100); }
  }
  if (!portFile) throw new Error(`Chrome 无法启动：${chromeError}`);
  const [port, endpoint] = portFile.trim().split('\n');
  const connection = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  socket = connection;
  await new Promise<void>((resolve, reject) => {
    connection.addEventListener('open', () => resolve(), { once: true });
    connection.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const errors: string[] = [];
  connection.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(message.params.exceptionDetails));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  connection.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Chrome 连接已关闭'));
    }
    pending.clear();
  });
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    connection.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: webUrl });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression: string) => {
    const result = await send!('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Runtime.enable', {}, sessionId);
  const wait = async (expression: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      const error = await evaluate("document.querySelector('#content .error-box')?.textContent");
      if (error) throw new Error(error);
      await delay(50);
    }
    throw new Error(`页面等待超时：${expression}\n${await evaluate("document.body.innerText")}`);
  };
  const click = (label: string, scope = '#content') => evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(b => (b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)}) && !b.disabled);
    if (!button) throw new Error('找不到按钮：' + ${JSON.stringify(label)}); button.click();
  })()`);
  const route = async (hash: string, ready: string) => {
    await evaluate(`location.hash = ${JSON.stringify('#/' + hash)}`);
    await wait(ready);
  };
  await wait("document.querySelector('#login-form') && !document.querySelector('#login-view').hidden");
  await evaluate(`document.querySelector('#login-password').value = ${JSON.stringify(password)}; document.querySelector('#login-form').requestSubmit()`);
  await wait("!document.querySelector('#app-view').hidden && document.querySelector('#content .stats-grid')");
  await route('schedules', "document.querySelector('#content').innerText.includes('调度列表')");
  await route('apps', "document.querySelector('#content').innerText.includes('Worker 在线')");
  await route('podcast-shows', "document.querySelector('#content .queue-pagination')");
  assert.match(await evaluate("document.querySelector('#content .queue-pagination').innerText"), /共 27 项/);
  await click('下一页');
  await wait("document.querySelector('#content .queue-pagination')?.innerText.includes('第 2 / 2 页')");
  await evaluate("[...document.querySelectorAll('#content tbody tr')].find(tr => tr.querySelector('.show-title')?.textContent === '测试节目 0').querySelector('[aria-label=\"查看单集\"]').click()");
  await wait("!document.querySelector('#modal-root').hidden && document.querySelector('#modal-root .queue-pagination')");
  await evaluate("document.querySelector('#modal-root tbody input[type=checkbox]').click()");
  await click('下一页', '#modal-root');
  await wait("document.querySelector('#modal-root .queue-pagination')?.innerText.includes('第 2 / 2 页')");
  assert.equal(await evaluate("document.querySelectorAll('#modal-root tbody tr').length"), 15);
  await evaluate("document.querySelector('#modal-root input[aria-label=\"全选当前显示\"]').click()");
  assert.match(await evaluate("document.querySelector('#modal-root .toolbar').innerText"), /已选 16 集/);
  await click('上一页', '#modal-root');
  await wait("document.querySelector('#modal-root .queue-pagination')?.innerText.includes('第 1 / 2 页')");
  assert.equal(await evaluate("document.querySelector('#modal-root tbody input[type=checkbox]').checked"), true);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
  await route('podcast-shows?tab=candidate', "document.querySelector('#content .queue-pagination')?.innerText.includes('第 1 / 2 页')");
  await click('下一页');
  await wait("document.querySelector('#content .queue-pagination')?.innerText.includes('第 2 / 2 页')");
  await route('episodes', "document.querySelector('#content').innerText.includes('单集库') && document.querySelector('#content tbody tr')");
  await route('episodes?tab=transcripts', "document.querySelector('#content').innerText.includes('转写内容')");
  await click('下一页');
  await wait("document.querySelector('#content .queue-pagination')?.innerText.includes('第 2 / 2 页')");
  assert.equal(await evaluate("document.querySelectorAll('#content tbody tr').length"), 6);
  await route(`transcript/${encodeURIComponent(transcriptEpisode)}`, "document.querySelectorAll('#content .transcript-turn').length === 2");
  assert.match(await evaluate("document.querySelector('#content').innerText"), /说话者 1[\s\S]*说话者 2/);
  assert.equal(await evaluate("document.querySelector('#content .transcript-card script') === null"), true);
  await evaluate("window.__copied = ''; navigator.clipboard.writeText = async value => { window.__copied = value; }");
  await evaluate("[...document.querySelectorAll('#page-actions button')].find(b=>b.textContent.includes('复制当前稿件')).click()");
  await wait("window.__copied.includes('说话者 2')");
  await evaluate("const select = document.querySelector('[aria-label=\"稿件版本\"]'); select.value='1'; select.dispatchEvent(new Event('change'))");
  await wait("document.querySelector('#content .markdown')");
  assert.match(await evaluate("document.querySelector('#content .markdown').innerText"), /浏览器检查转写内容/);
  await route('tasks?tab=transcribe', "document.querySelector('#content .queue-pagination')?.innerText.includes('共 65 项')");
  await evaluate("document.querySelector('#content input[aria-label=\"全选当前页\"]').click()");
  await click('下一页');
  await wait("document.querySelector('#content .queue-pagination')?.innerText.includes('第 2 / 4 页')");
  await evaluate("document.querySelector('#content input[aria-label=\"全选当前页\"]').click()");
  assert.match(await evaluate("document.querySelector('#content .queue-bulk-count').innerText"), /已选 40 项/);
  await route('tasks?tab=collect', "document.querySelector('#content .queue-pagination')?.innerText.includes('第 1 页')");
  await click('下一页');
  await wait("document.querySelector('#content .queue-pagination')?.innerText.includes('第 2 页')");
  assert.equal(await evaluate("document.querySelectorAll('#content tbody tr').length"), 5);
  await route('tasks-all', "document.querySelector('#content').innerText.includes('任务列表')");
  assert.deepEqual(errors, []);
  console.log('Chrome 页面检查通过：登录、分页、v1/v2切换、双人阅读、安全文本和带标签复制');
} finally {
  await send?.('Browser.close').catch(() => {});
  socket?.close();
  if (chrome.exitCode === null) chrome.kill('SIGTERM');
  await new Promise<void>((resolve) => web.close(() => resolve()));
  await new Promise<void>((resolve) => platform.close(() => resolve()));
  store.closeDb();
  // Chrome 完全退出后删除它的临时配置文件。
  for (let i = 0; chrome.exitCode === null && i < 20; i++) await delay(50);
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
