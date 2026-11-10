/** SQLite 在线快照 + 不可变产物；演练只恢复到新目录。 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type Artifact = { id: string; byte_size: number; sha256: string };
type Manifest = { version: 1; created_at: string; database_sha256: string; artifacts: Artifact[] };

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function checkDatabase(db: DatabaseSync): Artifact[] {
  const check = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (check.length !== 1 || check[0].integrity_check !== 'ok') throw new Error('数据库完整性检查失败');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('数据库外键检查失败');
  return db.prepare('SELECT id, byte_size, sha256 FROM artifacts ORDER BY id').all() as Artifact[];
}

async function checkArtifact(path: string, artifact: Artifact): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(artifact.id)) throw new Error('无效产物 ID');
  const info = await lstat(path);
  if (!info.isFile() || info.size !== artifact.byte_size || await digest(path) !== artifact.sha256) {
    throw new Error(`产物校验失败：${artifact.id}`);
  }
}

export async function backupData(dataDir: string, destination: string): Promise<void> {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(target), '.taskbase-backup-'));
  try {
    const database = join(staging, 'taskbase.sqlite');
    const source = new DatabaseSync(join(dataDir, 'taskbase.sqlite'), { readOnly: true });
    try { await backup(source, database); } finally { source.close(); }
    await chmod(database, 0o600);
    const snapshot = new DatabaseSync(database, { readOnly: true });
    let artifacts: Artifact[];
    try { artifacts = checkDatabase(snapshot); } finally { snapshot.close(); }
    await mkdir(join(staging, 'artifacts'), { mode: 0o700 });
    for (const artifact of artifacts) {
      const file = join(dataDir, 'artifacts', artifact.id);
      await checkArtifact(file, artifact);
      const copy = join(staging, 'artifacts', artifact.id);
      await copyFile(file, copy);
      await chmod(copy, 0o600);
      await checkArtifact(copy, artifact);
    }
    const manifest: Manifest = { version: 1, created_at: new Date().toISOString(),
      database_sha256: await digest(database), artifacts };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    // 创建目标目录保证不覆盖任何已有文件或备份；完成前目录中没有 manifest。
    await mkdir(target, { mode: 0o700 });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(directory: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.artifacts)) throw new Error('备份 manifest 无效');
  const database = join(directory, 'taskbase.sqlite');
  if (await digest(database) !== manifest.database_sha256) throw new Error('数据库 SHA-256 不匹配');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (JSON.stringify(checkDatabase(db)) !== JSON.stringify(manifest.artifacts)) throw new Error('产物清单不匹配');
  } finally { db.close(); }
  for (const artifact of manifest.artifacts) await checkArtifact(join(directory, 'artifacts', artifact.id), artifact);
  return manifest;
}

export async function rehearseRestore(directory: string, destination: string): Promise<void> {
  const manifest = await verifyBackup(directory);
  const target = resolve(destination);
  await mkdir(target, { mode: 0o700 }); // 必须是新目录；不会覆盖线上数据。
  await copyFile(join(directory, 'taskbase.sqlite'), join(target, 'taskbase.sqlite'));
  await chmod(join(target, 'taskbase.sqlite'), 0o600);
  await mkdir(join(target, 'artifacts'), { mode: 0o700 });
  for (const artifact of manifest.artifacts) {
    const file = join(target, 'artifacts', artifact.id);
    await copyFile(join(directory, 'artifacts', artifact.id), file);
    await chmod(file, 0o600);
  }
  const db = new DatabaseSync(join(target, 'taskbase.sqlite'));
  try {
    checkDatabase(db);
    // 验证恢复目录可写；不开启 API、调度器或 Worker，不触发旧任务。
    db.exec('BEGIN IMMEDIATE; ROLLBACK;');
  } finally { db.close(); }
  for (const artifact of manifest.artifacts) await checkArtifact(join(target, 'artifacts', artifact.id), artifact);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, destination] = process.argv.slice(2);
  if (!source || !['create', 'verify', 'rehearse'].includes(command ?? '') || (command !== 'verify' && !destination)) {
    throw new Error('用法：node scripts/backup.ts create <数据目录> <新备份目录> | verify <备份目录> | rehearse <备份目录> <新恢复目录>');
  }
  if (command === 'create') await backupData(source, destination!);
  else if (command === 'verify') await verifyBackup(source);
  else await rehearseRestore(source, destination!);
  console.log(`${command} 完成`);
}
