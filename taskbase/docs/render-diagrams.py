#!/usr/bin/env python3
"""Generate the Taskbase architecture and flow diagrams as PNGs.

Requires Pillow. Run from taskbase/: python3 docs/render-diagrams.py
"""
from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
OUT = Path(__file__).resolve().parent / 'diagrams'
OUT.mkdir(parents=True, exist_ok=True)

BG = '#f4f7fb'
INK = '#12263a'
MUTED = '#5b6b7c'
GRID = '#dbe4ef'

CLIENT = ('#e8f0fe', '#9bbcf2')
API = ('#1f3a5f', '#1f3a5f')
SERVICE = ('#ffffff', '#c6d3e2')
SCHED = ('#fff4e5', '#efb46a')
DATA = ('#eef2f7', '#a9b8c9')
ART = ('#f6eefc', '#c5a9e8')
WORKER = ('#e9f7ee', '#8fce9f')
FUTURE = ('#fafcff', '#b9c6d6')
GREEN = ('#e8f7ee', '#79c28d')
RED = ('#fdecec', '#e39a9a')
GRAY = ('#f0f3f6', '#b7c2ce')
PURPLE = ('#f1edfb', '#b7a6e0')
ORANGE = ('#fff4e5', '#efb46a')
BLUE = ('#e8f0fe', '#9bbcf2')

_fonts: dict[int, ImageFont.FreeTypeFont] = {}


def font(size: int) -> ImageFont.FreeTypeFont:
    if size not in _fonts:
        _fonts[size] = ImageFont.truetype(FONT_PATH, size)
    return _fonts[size]


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, size: int = 16,
         fill: str = INK, anchor: str = 'la') -> None:
    draw.text(xy, value, font=font(size), fill=fill, anchor=anchor)


def box(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, title: str,
        lines: tuple[str, ...] = (), fill: str = '#ffffff', border: str = '#c6d3e2',
        title_color: str = INK, body_color: str = MUTED, accent: str | None = None,
        dashed: bool = False, title_size: int = 22, body_size: int = 15) -> None:
    draw.rounded_rectangle((x + 5, y + 7, x + w + 5, y + h + 7), radius=14, fill='#e9eef5')
    if dashed:
        dashed_rect(draw, x, y, w, h, border)
        draw.rounded_rectangle((x, y, x + w, y + h), radius=14, fill=fill, outline=None)
        dashed_rect(draw, x, y, w, h, border)
    else:
        draw.rounded_rectangle((x, y, x + w, y + h), radius=14, fill=fill, outline=border, width=2)
    if accent:
        draw.rounded_rectangle((x, y, x + 7, y + h), radius=4, fill=accent)
    text(draw, (x + 22, y + 14), title, title_size, title_color)
    for index, line in enumerate(lines):
        text(draw, (x + 22, y + 50 + index * 23), line, body_size, body_color)


def dashed_rect(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, color: str) -> None:
    dash, gap = 10, 7
    for start in range(x, x + w, dash + gap):
        draw.line((start, y, min(start + dash, x + w), y), fill=color, width=2)
        draw.line((start, y + h, min(start + dash, x + w), y + h), fill=color, width=2)
    for start in range(y, y + h, dash + gap):
        draw.line((x, start, x, min(start + dash, y + h)), fill=color, width=2)
        draw.line((x + w, start, x + w, min(start + dash, y + h)), fill=color, width=2)


def dashed_line(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], color: str, width: int = 2) -> None:
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        length = math.hypot(x2 - x1, y2 - y1)
        if length == 0:
            continue
        step, dash = 10, 7
        count = int(length // (dash + step)) + 1
        for index in range(count):
            start = index * (dash + step)
            end = min(start + dash, length)
            if start >= length:
                break
            sx = x1 + (x2 - x1) * start / length
            sy = y1 + (y2 - y1) * start / length
            ex = x1 + (x2 - x1) * end / length
            ey = y1 + (y2 - y1) * end / length
            draw.line((sx, sy, ex, ey), fill=color, width=width)


def arrow(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], color: str = '#5f7184',
          width: int = 3, dashed: bool = False, label: str | None = None,
          label_xy: tuple[int, int] | None = None, label_size: int = 14) -> None:
    if dashed:
        dashed_line(draw, points, color, width)
    else:
        draw.line(points, fill=color, width=width)
    x1, y1 = points[-2]
    x2, y2 = points[-1]
    angle = math.atan2(y2 - y1, x2 - x1)
    size = 13
    left = (x2 - size * math.cos(angle - math.pi / 6), y2 - size * math.sin(angle - math.pi / 6))
    right = (x2 - size * math.cos(angle + math.pi / 6), y2 - size * math.sin(angle + math.pi / 6))
    draw.polygon([(x2, y2), left, right], fill=color)
    if label and label_xy:
        bbox = draw.textbbox(label_xy, label, font=font(label_size), anchor='mm')
        draw.rounded_rectangle((bbox[0] - 5, bbox[1] - 3, bbox[2] + 5, bbox[3] + 3),
                               radius=5, fill=BG)
        text(draw, label_xy, label, label_size, MUTED, anchor='mm')


def canvas(width: int, height: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new('RGB', (width, height), BG)
    draw = ImageDraw.Draw(image)
    return image, draw


def architecture() -> None:
    width, height = 1800, 1200
    image, draw = canvas(width, height)
    text(draw, (60, 34), 'Taskbase 系统架构（底座 v0.2 + 播客 Web）', 36, INK)
    text(draw, (60, 84), '单用户 · 单服务器 · CLI / Web · 任务控制面 · 播客 Worker · SQLite', 18, MUTED)

    # 客户端
    box(draw, 80, 140, 300, 90, 'CLI', ('登录 / 提交 / 调度 / 产物',), *CLIENT)
    box(draw, 430, 140, 380, 90, 'Web 端', ('管理后台 · 播客任务后台',), *CLIENT)
    text(draw, (930, 168), 'HTTPS / JSON', 15, MUTED)

    # 服务器边界
    dashed_rect(draw, 50, 270, 1700, 820, '#9fb0c4')
    text(draw, (72, 282), '远程服务器（单机部署）', 16, MUTED)

    # Web Server 与 API
    box(draw, 400, 300, 360, 100, 'Web Server（node:http）',
        ('会话 Cookie · 平台代理 · 播客 API',), *SERVICE, accent='#7aa7d9', title_size=20)
    box(draw, 900, 300, 480, 100, 'Platform API（node:http）',
        ('认证 · 应用定义 · 任务 · 调度 · 事件 · 产物',), *API,
        title_color='#ffffff', body_color='#dbe7f5', title_size=20)

    # 客户端箭头
    arrow(draw, [(230, 230), (230, 285), (1050, 285), (1050, 300)], '#5f7184')
    arrow(draw, [(610, 230), (610, 300)], '#5f7184')
    arrow(draw, [(760, 350), (900, 350)], '#5f7184', label='内部 HTTP', label_xy=(830, 336))
    # Web Server 直接访问播客表
    arrow(draw, [(400, 350), (380, 350), (380, 620), (700, 620), (700, 650)], '#7c8ea2',
          label='podcast_ 表', label_xy=(545, 608), dashed=True)

    # 能力层
    capabilities = [
        (80, '认证与 Token', ('所有者登录', 'CLI / Worker 凭据隔离'), SERVICE, None),
        (390, '应用与任务定义', ('注册 / 覆盖更新', '输入 / 输出 schema'), SERVICE, None),
        (700, '任务控制面', ('幂等提交 / 队列', '租约 / 尝试 / 回收'), SERVICE, '#7aa7d9'),
        (1010, '调度器', ('5 字段 cron', '重叠跳过 / 漏跑跳过'), SCHED, '#efb46a'),
        (1320, '产物服务', ('上传 / 下载', '大小与 SHA-256 校验'), ART, '#c5a9e8'),
    ]
    for x, title, lines, (fill, border), accent in capabilities:
        box(draw, x, 450, 290, 140, title, lines, fill, border, accent=accent, title_size=20, body_size=15)

    # API 到能力层
    draw.line((1140, 400, 1140, 425), fill='#7c8ea2', width=3)
    draw.line((225, 425, 1465, 425), fill='#7c8ea2', width=3)
    for x in (225, 535, 845, 1155, 1465):
        arrow(draw, [(x, 425), (x, 450)], '#7c8ea2')

    # 数据层
    box(draw, 80, 650, 620, 180, 'SQLite（WAL）',
        ('users / apps / task_definitions', 'tasks / attempts / steps / events',
         'artifacts / schedules / schedule_runs', 'podcast_shows / episodes / ingest_runs'),
        *DATA, title_size=20, body_size=15)
    box(draw, 1320, 650, 380, 180, '本地产物目录',
        ('.data/artifacts/', '任意 content-type', '单产物上限可配（默认 5 MiB）'),
        *ART, title_size=20, body_size=15)

    # 能力层到数据层
    arrow(draw, [(225, 590), (225, 650)], '#7c8ea2')
    arrow(draw, [(535, 590), (535, 650)], '#7c8ea2')
    arrow(draw, [(845, 590), (790, 650)], '#7c8ea2', label='读写', label_xy=(790, 620))
    arrow(draw, [(1155, 590), (1155, 620), (700, 620), (700, 650)], '#7c8ea2',
          label='调度表', label_xy=(930, 608))
    arrow(draw, [(1465, 590), (1465, 650)], '#7c8ea2', label='产物字节', label_xy=(1465, 620))

    # Worker 层
    box(draw, 80, 880, 290, 110, 'Worker SDK', ('领取 / 心跳 / 进度 / 步骤 / 产物',), *SERVICE, title_size=20)
    box(draw, 420, 880, 300, 110, 'Demo Worker', ('demo/echo', '验证闭环'), *WORKER, title_size=20)
    box(draw, 760, 880, 380, 110, 'Podcast Worker', ('节目列表采集 / 单集任务', 'podcast_ 应用表'), *WORKER, title_size=20)

    # Worker 协议箭头
    arrow(draw, [(570, 880), (570, 820), (760, 820), (760, 590)], '#4f8f68',
          label='lease / heartbeat / complete', label_xy=(700, 806), label_size=13)
    arrow(draw, [(940, 880), (940, 590)], '#4f8f68', label='Worker 协议', label_xy=(1015, 730), label_size=13)
    arrow(draw, [(370, 935), (420, 935)], '#6c9a7f', dashed=True, label='SDK', label_xy=(395, 918), label_size=12)
    arrow(draw, [(760, 935), (720, 935), (720, 830)], '#4f8f68', label='应用表', label_xy=(700, 850), label_size=12)

    # 图例
    legend = [('客户端', '#e8f0fe'), ('平台能力', '#ffffff'), ('调度', '#fff4e5'),
              ('数据', '#eef2f7'), ('Worker', '#e9f7ee')]
    lx = 80
    for label, color in legend:
        draw.rounded_rectangle((lx, 1135, lx + 26, 1157), radius=6, fill=color, outline='#b9c6d6')
        text(draw, (lx + 36, 1143), label, 14, MUTED)
        lx += 170
    image.save(OUT / 'architecture.png')

def task_flow() -> None:
    width, height = 1500, 1150
    image, draw = canvas(width, height)
    text(draw, (60, 34), 'Taskbase 任务执行流程', 34, INK)
    text(draw, (60, 82), '提交 → 排队 → 领取 → 执行 → 成功 / 失败 / 恢复 / 关闭 → 重试', 17, MUTED)

    # 主链路
    box(draw, 560, 120, 380, 82, '提交任务', ('CLI / Web：app/task + input',), *CLIENT, title_size=22)
    box(draw, 560, 244, 380, 82, '校验 + 幂等', ('schema / Idempotency-Key',), *SERVICE, title_size=22)
    box(draw, 560, 368, 380, 82, 'queued', ('写入队列 + 事件',), *BLUE, title_size=24)
    box(draw, 560, 500, 380, 82, 'running', ('Worker 领取 + 租约 + Attempt',), *ORANGE, title_size=24)

    arrow(draw, [(750, 202), (750, 244)])
    arrow(draw, [(750, 326), (750, 368)])
    arrow(draw, [(750, 450), (750, 500)])

    # 右侧终态
    box(draw, 1080, 520, 320, 82, 'succeeded', ('complete + 输出 schema 校验',), *GREEN, title_size=24)
    box(draw, 1080, 650, 320, 82, 'failed', ('Worker 主动 fail',), *RED, title_size=24)
    box(draw, 1080, 800, 320, 100, 'closed', ('TIMEOUT / MANUAL', 'QUEUE_TIMEOUT'), *GRAY, title_size=24, body_size=14)
    arrow(draw, [(940, 540), (1080, 560)], '#4f8f68')
    arrow(draw, [(940, 550), (1080, 690)], '#c06b6b')
    arrow(draw, [(940, 560), (1080, 845)], '#7c8ea2')

    # 左侧恢复/关闭
    box(draw, 180, 560, 300, 82, 'recovering', ('租约过期，尝试未耗尽',), *PURPLE, title_size=22)
    box(draw, 160, 690, 340, 82, 'closed', ('ATTEMPTS_EXHAUSTED（尝试耗尽）',), *GRAY, title_size=22, body_size=14)
    box(draw, 180, 360, 300, 82, 'closed / QUEUE_TIMEOUT', ('排队超时',), *GRAY, title_size=18)
    arrow(draw, [(560, 540), (480, 590)], '#8a7bb0')
    arrow(draw, [(330, 642), (330, 690)], '#7c8ea2')
    arrow(draw, [(480, 590), (560, 530)], '#8a7bb0')
    arrow(draw, [(560, 410), (480, 395)], '#7c8ea2')

    # 重试：从 failed / closed 右侧绕行，避免穿过 closed 框
    box(draw, 560, 940, 380, 90, '重试 → 新任务', ('retry_of_task_id；原任务保留历史',), *SERVICE, title_size=22)
    arrow(draw, [(1400, 691), (1460, 691), (1460, 985), (940, 985)], '#c06b6b', label='retry', label_xy=(1430, 760))
    arrow(draw, [(1400, 850), (1460, 850), (1460, 985), (940, 985)], '#7c8ea2', dashed=True)
    text(draw, (980, 610), '成功', 14, '#4f8f68')
    text(draw, (990, 710), '失败', 14, '#c06b6b')
    text(draw, (1000, 860), '超时/人工关闭', 14, MUTED)

    # 图例
    legend = [('排队', '#e8f0fe'), ('执行', '#fff4e5'), ('恢复', '#f1edfb'),
              ('成功', '#e8f7ee'), ('失败', '#fdecec'), ('关闭', '#f0f3f6')]
    lx = 80
    for label, color in legend:
        draw.rounded_rectangle((lx, 1085, lx + 24, 1105), radius=5, fill=color, outline='#b9c6d6')
        text(draw, (lx + 32, 1092), label, 13, MUTED)
        lx += 150
    image.save(OUT / 'task-flow.png')


def decision(draw: ImageDraw.ImageDraw, cx: int, cy: int, w: int, h: int, value: str,
             fill: str = '#ffffff', border: str = '#b9c6d6') -> None:
    points = [(cx, cy - h // 2), (cx + w // 2, cy), (cx, cy + h // 2), (cx - w // 2, cy)]
    draw.polygon(points, fill=fill, outline=border, width=2)
    text(draw, (cx, cy), value, 17, INK, anchor='mm')


def schedule_flow() -> None:
    width, height = 1500, 1050
    image, draw = canvas(width, height)
    text(draw, (60, 34), 'Taskbase 调度触发流程', 34, INK)
    text(draw, (60, 82), '每 5 秒扫描一次；cron 到点后按重叠/漏跑策略创建或跳过', 17, MUTED)

    box(draw, 520, 120, 420, 82, 'Schedule', ('cron + 时区 + 固定输入',), *SCHED, title_size=22)
    box(draw, 520, 244, 420, 82, 'schedulerTick（每 5 秒）', ('查询 enabled + next_fire_at <= now',), *SERVICE, title_size=22)
    decision(draw, 730, 380, 230, 86, '到期？')
    decision(draw, 730, 510, 280, 86, '同 schedule 活跃？')
    decision(draw, 730, 640, 250, 86, '超过 grace？')
    box(draw, 520, 740, 420, 92, '创建 queued 任务', ('source=schedule + schedule_id + planned_fire_time',), *BLUE, title_size=22)
    box(draw, 520, 872, 420, 78, '推进 next_fire', ('计算下一次未来触发',), *SERVICE, title_size=22)

    arrow(draw, [(730, 202), (730, 244)])
    arrow(draw, [(730, 326), (730, 380)])
    arrow(draw, [(730, 423), (730, 510)], label='是', label_xy=(750, 465))
    arrow(draw, [(730, 553), (730, 640)], label='否', label_xy=(750, 595))
    arrow(draw, [(730, 683), (730, 740)], label='否', label_xy=(750, 710))
    arrow(draw, [(730, 832), (730, 872)])

    # 跳过分支
    box(draw, 1070, 470, 300, 86, '记录 skipped_overlap', ('不创建任务，推进 next_fire',), *GRAY, title_size=18)
    box(draw, 1070, 605, 300, 86, '记录 skipped_missed', ('不补跑，推进 next_fire',), *GRAY, title_size=18)
    box(draw, 1070, 360, 280, 70, '等待下一次扫描', ('下一次 tick 再检查',), *FUTURE, title_size=18)
    arrow(draw, [(845, 380), (1070, 380)], label='否', label_xy=(960, 362))
    arrow(draw, [(870, 510), (1070, 510)], label='是', label_xy=(960, 492))
    arrow(draw, [(855, 640), (1070, 640)], label='是', label_xy=(960, 622))
    arrow(draw, [(1370, 513), (1430, 513), (1430, 910), (940, 910)], '#7c8ea2', dashed=True,
          label='推进 next_fire', label_xy=(1335, 780), label_size=12)
    arrow(draw, [(1370, 648), (1430, 648), (1430, 910), (940, 910)], '#7c8ea2', dashed=True)

    # Worker
    box(draw, 520, 968, 420, 70, 'Worker 领取并执行', ('与普通任务共用状态机',), '#ffffff', '#c6d3e2', title_size=18, body_size=13)
    arrow(draw, [(730, 950), (730, 968)])
    image.save(OUT / 'schedule-flow.png')


if __name__ == '__main__':
    architecture()
    task_flow()
    schedule_flow()
    print('diagrams written to', OUT)
