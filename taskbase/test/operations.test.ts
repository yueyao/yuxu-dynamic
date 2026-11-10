import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { backupData, rehearseRestore, verifyBackup } from '../scripts/backup.ts';
import { maintain } from '../scripts/maintenance.ts';
import { sha256 } from '../src/crypto.ts';
import { Store } from '../src/store.ts';

test('运维：在线备份包含 WAL 与产物，恢复到新目录，损坏和覆盖被拒绝', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-operations-'));
  const data = join(dir, 'data');
  const store = new Store(join(data, 'taskbase.sqlite'));
  t.after(async () => { store.closeDb(); await rm(dir, { recursive: true, force: true }); });
  store.upsertApp({ app_id: 'test', display_name: 'Test', tasks: [{ task_key: 'echo', display_name: 'Echo',
    input_schema: { type: 'object' }, output_schema: { type: 'object' } }] });
  store.createTask('owner', 'test', 'echo', {});
  const lease = store.lease('test')!;
  const id = randomUUID();
  const content = '备份产物';
  await mkdir(join(data, 'artifacts'));
  await writeFile(join(data, 'artifacts', id), content);
  store.createArtifact(lease.task_id, lease.attempt_id, 'test', id, 'test.txt', 'text/plain', Buffer.byteLength(content), sha256(content));
  const destination = join(dir, 'backup');
  await backupData(data, destination); // Store 保持打开，数据尚可在 WAL 中。
  assert.equal((await verifyBackup(destination)).artifacts.length, 1);
  const restored = join(dir, 'restore');
  await rehearseRestore(destination, restored);
  const recovered = new Store(join(restored, 'taskbase.sqlite'));
  assert.equal(recovered.listTasks().tasks.length, 1);
  recovered.closeDb();
  assert.equal(await readFile(join(restored, 'artifacts', id), 'utf8'), content);
  await assert.rejects(backupData(data, destination), { code: 'EEXIST' });
  await assert.rejects(rehearseRestore(destination, restored), { code: 'EEXIST' });
  await writeFile(join(destination, 'artifacts', id), 'corrupted');
  await assert.rejects(verifyBackup(destination), /产物校验失败/);
});

test('运维：清理默认预览，保留活动任务日志、状态事件和有引用的产物', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'taskbase-retention-'));
  const path = join(dir, 'taskbase.sqlite');
  const store = new Store(path);
  const db = new DatabaseSync(path);
  t.after(async () => { db.close(); store.closeDb(); await rm(dir, { recursive: true, force: true }); });
  store.upsertApp({ app_id: 'test', display_name: 'Test', tasks: [{ task_key: 'echo', display_name: 'Echo',
    input_schema: { type: 'object' }, output_schema: { type: 'object' } }] });
  const finished = store.createTask('owner', 'test', 'echo', {}).task.task_id;
  store.close(finished, 'owner', 'test');
  const active = store.createTask('owner', 'test', 'echo', {}).task.task_id;
  const old = Date.now() - 40 * 86_400_000;
  const insertLog = db.prepare("INSERT INTO task_events(task_id, type, payload_json, created_at) VALUES (?, 'log', '{}', ?)");
  insertLog.run(finished, old); insertLog.run(active, old);
  const orphan = randomUUID();
  const recent = randomUUID();
  await mkdir(join(dir, 'artifacts'));
  await writeFile(join(dir, 'artifacts', orphan), 'old orphan');
  await utimes(join(dir, 'artifacts', orphan), old / 1000, old / 1000);
  await writeFile(join(dir, 'artifacts', recent), 'recent upload');
  const preview = await maintain(dir);
  assert.equal(preview.logs, 1);
  assert.deepEqual(preview.orphan_artifacts, [orphan]);
  assert.equal(await readFile(join(dir, 'artifacts', orphan), 'utf8'), 'old orphan');
  await maintain(dir, { apply: true });
  await assert.rejects(readFile(join(dir, 'artifacts', orphan)), { code: 'ENOENT' });
  assert.equal(await readFile(join(dir, 'artifacts', recent), 'utf8'), 'recent upload');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE type = 'log'").get() as { n: number }).n, 1);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE type = 'status'").get() as { n: number }).n > 0);
});
