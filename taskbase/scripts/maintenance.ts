/** 默认预览：只清理已结束任务的旧日志及未被数据库引用的旧产物。 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export async function maintain(dataDir: string, options: { apply?: boolean; now?: number } = {}) {
  const db = new DatabaseSync(join(dataDir, 'taskbase.sqlite'), { readOnly: !options.apply });
  const now = options.now ?? Date.now();
  const logCutoff = now - 30 * 86_400_000;
  const orphanCutoff = now - 7 * 86_400_000;
  const expiredLogs = `type = 'log' AND created_at < ? AND task_id IN
    (SELECT id FROM tasks WHERE status IN ('succeeded', 'failed', 'closed'))`;
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const logs = (db.prepare(`SELECT COUNT(*) AS count FROM task_events WHERE ${expiredLogs}`)
      .get(logCutoff) as { count: number }).count;
    const orphans: string[] = [];
    const files = await readdir(join(dataDir, 'artifacts')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const referenced = db.prepare('SELECT 1 FROM artifacts WHERE id = ?');
    for (const id of files) {
      if (!/^[a-f0-9-]{36}$/.test(id) || referenced.get(id)) continue;
      const file = join(dataDir, 'artifacts', id);
      const info = await lstat(file);
      if (!info.isFile() || info.mtimeMs >= orphanCutoff) continue;
      orphans.push(id);
      if (options.apply) {
        // 先持有写锁再复查，不能删除刚被其他连接登记的产物。
        db.exec('BEGIN IMMEDIATE;');
        try {
          if (!referenced.get(id)) await unlink(file);
          db.exec('COMMIT;');
        } catch (error) { db.exec('ROLLBACK;'); throw error; }
      }
    }
    if (options.apply) db.prepare(`DELETE FROM task_events WHERE ${expiredLogs}`).run(logCutoff);
    return { applied: options.apply === true, logs, orphan_artifacts: orphans };
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory || directory.startsWith('--')) throw new Error('用法：node scripts/maintenance.ts <数据目录> [--apply]');
  console.log(JSON.stringify(await maintain(directory, { apply: process.argv.includes('--apply') }), null, 2));
}
