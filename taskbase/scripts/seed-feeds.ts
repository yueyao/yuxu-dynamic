#!/usr/bin/env node
/**
 * 一次性的 Feed 种子：为每个栏目建立 show + 一个停用的 show/sync schedule；
 * 知行小酒馆额外 run-now 一次（任务排队，不自动抓其他栏目）。
 *
 * 用法：TASKBASE_DATA_DIR=.data node scripts/seed-feeds.ts
 */
import { config } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { PODCAST_APP_ID, podcastManifest } from '../src/podcast/manifest.ts';
import { PodcastStore } from '../src/podcast/store.ts';

const feeds = [
  { title: '知行小酒馆', url: 'https://feed.xyzfm.space/j8yp8gxkmgqr', runNow: true },
  { title: '忽左忽右', url: 'https://feed.xyzfm.space/cv4bkgpuglwp' },
  { title: '声东击西', url: 'https://feeds.fireside.fm/shengdongjixi/rss' },
  { title: '日谈公园', url: 'https://www.ximalaya.com/album/5574153.xml' },
  { title: '文化有限', url: 'https://s1.proxy.wavpub.com/weknownothing.xml' },
  { title: '故事FM', url: 'https://feeds.storyfm.cn/storyfm.xml' },
  { title: '不合时宜', url: 'https://feed.xyzfm.space/ww7cqnybekty' },
  { title: '展开讲讲', url: 'https://www.ximalaya.com/album/24672021.xml' },
  { title: 'Mosaic of China', url: 'https://www.ximalaya.com/album/25694293.xml' },
];

const store = new Store(config.dbPath);
const podcast = new PodcastStore(config.dbPath);
try {
  const app = store.upsertApp(podcastManifest);
  const workerToken = app.worker_token ?? store.rotateWorkerToken(PODCAST_APP_ID);
  const schedules = store.listSchedules();
  let createdSchedules = 0;
  let runNowTaskId: string | null = null;
  for (const feed of feeds) {
    const show = podcast.ensureShowByUrl(feed.url, feed.title);
    podcast.updateShow(show.show_id, { title: feed.title, rssUrl: feed.url });
    let schedule = schedules.find((entry) => entry.app_id === PODCAST_APP_ID
      && entry.task_key === 'show/sync'
      && (entry.input as { show_id?: string }).show_id === show.show_id);
    if (!schedule) {
      schedule = store.createSchedule(PODCAST_APP_ID, 'show/sync', { show_id: show.show_id },
        '0 9 * * *', 'Asia/Shanghai', false);
      createdSchedules += 1;
      schedules.push(schedule);
    } else {
      schedule = store.updateSchedule(schedule.schedule_id, { enabled: false });
    }
    if (feed.runNow && !runNowTaskId) {
      const result = store.runScheduleNow(schedule.schedule_id);
      runNowTaskId = result.task?.task_id ?? null;
    }
  }
  console.log(JSON.stringify({
    feeds: feeds.length,
    created_schedules: createdSchedules,
    run_now_task_id: runNowTaskId,
    worker_token: workerToken,
    note: '所有 schedule 默认停用；知行小酒馆只 run-now 了一次。',
  }, null, 2));
} finally {
  store.closeDb();
  podcast.close();
}
