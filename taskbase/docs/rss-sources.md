# RSS 来源与首批栏目

调研/验证时间：2026-11-06

## 方法

不依赖 Podcast Index，先用 **Apple Podcasts Search API** 按栏目名搜索，拿到 `feedUrl`，再直接抓取 RSS。RSS 是播客托管方发布的真实 feed，Apple 只是一个目录。

> 这些 feed 不是小宇宙页面本身；小宇宙页面通常不暴露 feed URL。部分栏目由小宇宙的 `feed.xyzfm.space` 托管，部分是喜马拉雅、Fireside、StoryFM、Wavpub 等。

## 找到的 feed

| 栏目 | RSS | RSS 总条数 | 时间范围 | 备注 |
| --- | --- | ---: | --- | --- |
| 忽左忽右 | `https://feed.xyzfm.space/cv4bkgpuglwp` | 654 | 2018-01-28 → 2026-11-06 | 已实测入库 |
| 声东击西 | `https://feeds.fireside.fm/shengdongjixi/rss` | 435 | 2016-11-26 → 2026-11-05 | Fireside |
| 日谈公园 | `https://www.ximalaya.com/album/5574153.xml` | 869 | 2016-10-09 → 2026-11-04 | 喜马拉雅 |
| 文化有限 | `https://s1.proxy.wavpub.com/weknownothing.xml` | 367 | 2019-10-08 → 2026-11-03 | Wavpub |
| 故事FM | `https://feeds.storyfm.cn/storyfm.xml` | 1000 | 2017-07-06 → 2026-11-04 | StoryFM |
| 不合时宜 | `https://feed.xyzfm.space/ww7cqnybekty` | 292 | 2019-11-07 → 2026-11-06 | xyzfm |
| 展开讲讲 | `https://www.ximalaya.com/album/24672021.xml` | 171 | 2019-06-27 → 2026-10-15 | 喜马拉雅 |
| 知行小酒馆 | `https://feed.xyzfm.space/j8yp8gxkmgqr` | 269 | 2021-01-29 → 2026-10-30 | 有知有行 |
| Mosaic of China | `https://www.ximalaya.com/album/25694293.xml` | 117 | 2019-08-08 → 2023-09-19 | 2023 年后停更 |

## 已实测的栏目

用《忽左忽右》做了真实入库验证：

- RSS 总条数：654
- 两年范围（2024-11-06 → 2026-11-06）内：203 集
- 入库：203 集
- 覆盖状态：`full`
- 最新一集：`514 高林漫谈帝国巡游、朝圣之路与汽车旅行的兴起`（2026-11-06）
- 最早入库一集：`360 播客如何深度介入美国大选`（2024-11-08）
- 任务结果：`succeeded`，没有下载音频

## 关于 Podcast Index

Podcast Index 可以作为**补充发现层**：

- 它索引的是已有 RSS feed，不是 RSS 生成器；
- 需要免费 API Key，完整搜索需要签名鉴权；
- 对中文播客/小宇宙的覆盖率需要实测；
- 对上面这些栏目，Apple Podcasts Search 已经能拿到 feed，Podcast Index 不是必需。

后续如果要做“输入栏目名自动发现 RSS”，可以按以下顺序：

```text
栏目名 / 页面 URL
  → Apple Podcasts search/lookup
  → Podcast Index search
  → 页面 <link rel="alternate" type="application/rss+xml">
  → 页面抓取 fallback（partial）
```

## 注意

- RSS 链接可能重定向、换域名或失效；worker 会跟随重定向并校验 XML。
- 部分 feed 使用 HTTP，worker 会安全地跟随到 HTTPS。
- RSS 条目数会随更新变化；上表是 2026-11-06 的快照。
- 这些 feed 是公开可访问的 RSS；入库只保存列表元数据，不下载音频。
