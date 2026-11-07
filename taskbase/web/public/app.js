(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const content = $('#content');
  const state = {
    me: null,
    route: 'overview',
    apps: [],
    taskFilters: { app: '', status: '' },
    selectedShowIds: new Set(),
  };

  const routes = {
    overview: { title: '总览', subtitle: '平台与播客任务运行概况', render: renderOverview },
    tasks: { title: '任务', subtitle: '提交、执行、关闭与重试', render: renderTasks },
    apps: { title: '应用', subtitle: '任务定义与 Worker 凭据', render: renderApps },
    schedules: { title: '调度', subtitle: 'cron 调度、下次触发与运行历史', render: renderSchedules },
    'podcast-shows': { title: '节目库', subtitle: '节目、单集与两年范围采集', render: renderPodcastShows },
    'transcribe-queue': { title: '转写', subtitle: '队列、顺序与已入库转写稿', render: renderTranscribeQueue },
    'podcast-tasks': { title: '采集任务', subtitle: '播客任务列表与结果', render: renderPodcastTasks },
    transcript: { title: '转写稿', subtitle: '在 Web 中阅读转写 Markdown', render: renderTranscript },
  };

  const STATUS_LABELS = {
    queued: '排队', running: '执行中', recovering: '恢复中', succeeded: '成功',
    failed: '失败', closed: '已关闭', enabled: '启用', disabled: '停用',
    partial: '不完整', full: '完整', unknown: '未知', created: '已创建',
    skipped_overlap: '重叠跳过', skipped_missed: '漏跑跳过', error: '错误',
  };

  // ---------- DOM 基础 ----------

  function appendChildren(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node) {
        try { node[key] = value; } catch { node.setAttribute(key, value); }
      } else {
        node.setAttribute(key, value);
      }
    }
    appendChildren(node, children);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function option(value, label, selected = false) {
    return el('option', { value, selected }, label);
  }

  function badge(status) {
    const normalized = status || 'unknown';
    return el('span', { class: `badge badge-${normalized}` }, STATUS_LABELS[normalized] || normalized);
  }

  function pill(value, className = '') {
    return el('span', { class: `pill ${className}`.trim() }, value);
  }

  function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  }

  function shortId(value) {
    return value ? String(value).slice(0, 8) : '—';
  }

  function icon(name, size = 18) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function actionButton(label, iconName, onClick, className = 'btn') {
    return el('button', { class: className, type: 'button', onClick }, icon(iconName), label);
  }

  function iconAction(label, iconName, onClick, className = 'btn btn-sm') {
    return el('button', { class: className, type: 'button', title: label, 'aria-label': label, onClick }, icon(iconName));
  }

  function fmtRelative(value) {
    if (!value) return '—';
    const target = Date.parse(value);
    if (!Number.isFinite(target)) return '—';
    const delta = target - Date.now();
    const abs = Math.abs(delta);
    const suffix = delta >= 0 ? '后' : '前';
    if (abs < 60_000) return delta >= 0 ? '即将触发' : '刚刚';
    if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`;
    if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`;
    return `${Math.round(abs / 86_400_000)} 天${suffix}`;
  }

  function toast(message, type = 'info') {
    const node = el('div', { class: `toast toast-${type}` }, message);
    $('#toast-root').append(node);
    setTimeout(() => node.remove(), 4000);
  }

  function setPageActions(...actions) {
    const root = $('#page-actions');
    clear(root);
    for (const action of actions.flat()) if (action) root.append(action);
  }

  function showLoading() {
    clear(content);
    content.append(el('div', { class: 'loading-row' }, el('div', { class: 'spinner' }), '加载中…'));
  }

  function emptyState(title, description, iconName = 'layers') {
    return el('div', { class: 'empty' },
      el('div', { class: 'empty-icon' }, icon(iconName)),
      el('strong', {}, title),
      description ? el('p', {}, description) : null);
  }

  function statCard(label, value, foot, iconName, tone = 'blue') {
    return el('section', { class: 'card stat-card' },
      el('div', { class: `stat-icon ${tone}` }, icon(iconName)),
      el('div', { class: 'stat-content' },
        el('div', { class: 'stat-label' }, label),
        el('div', { class: 'stat-value' }, value),
        foot ? el('div', { class: 'stat-foot' }, foot) : null));
  }

  function progressBar(value, tone = '') {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    const bar = el('div', { class: 'progress' }, el('div', { class: `progress-fill ${tone}` }));
    const fill = bar.firstElementChild;
    fill.style.width = `${percent}%`;
    return bar;
  }

  function progressCell(value, status) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    return el('div', {},
      progressBar(percent, status === 'succeeded' ? 'green' : ''),
      el('div', { class: 'progress-meta' }, `${percent}%`));
  }

  function coverageBar(show) {
    const page = Number(show.page_episode_count) || 0;
    const total = Number(show.total_episode_count) || Math.max(page, Number(show.episode_count) || 0);
    const percent = total > 0 ? Math.min(100, Math.round((page / total) * 100)) : 0;
    return el('div', { class: 'coverage' },
      progressBar(percent),
      el('div', { class: 'coverage-text' }, `${page}/${total || '—'} 集`));
  }

  function showCover(show) {
    const cover = el('div', { class: 'show-cover' }, (show.title || '?').trim().slice(0, 1).toUpperCase());
    if (show.cover_url) {
      const image = el('img', {
        src: show.cover_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
      });
      image.addEventListener('error', () => image.remove());
      cover.append(image);
    }
    return cover;
  }

  function card(title, subtitle, ...body) {
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, title),
          subtitle ? el('div', { class: 'card-sub' }, subtitle) : null)),
      el('div', { class: 'card-body' }, ...body));
  }

  function table(headers, rows, options = {}) {
    const thead = el('thead', {}, el('tr', {}, headers.map((header) => el('th', {}, header))));
    const tbody = el('tbody', {}, rows.map((cells) => {
      const tr = el('tr', options.onRowClick ? { class: 'clickable' } : {});
      if (options.onRowClick) tr.addEventListener('click', () => options.onRowClick());
      for (const cell of cells) {
        const td = el('td', {});
        appendChildren(td, [cell]);
        tr.append(td);
      }
      return tr;
    }));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, thead, tbody));
  }

  function kv(pairs) {
    return el('dl', { class: 'kv' }, pairs.map(([key, value]) => [
      el('dt', {}, key), el('dd', {}, value ?? '—'),
    ]));
  }

  function pre(value) {
    return el('pre', { class: 'pre' }, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }

  function copyButton(text) {
    return el('button', {
      class: 'btn btn-sm', type: 'button',
      onClick: async () => {
        try { await navigator.clipboard.writeText(text); toast('已复制', 'success'); }
        catch { toast('复制失败，请手动选择文本', 'error'); }
      },
    }, '复制');
  }

  function showTokenModal(title, token) {
    if (!token) {
      showModal({ title, body: el('p', {}, '没有返回新的 Worker Token。应用可能已存在；可在应用列表里轮换 Token。') });
      return;
    }
    showModal({
      title,
      subtitle: '只显示一次，请立即保存',
      body: [
        el('div', { class: 'token-box' }, token),
        el('div', { class: 'hint' }, '这个 Token 用于启动 Worker，不要放进浏览器代码。'),
      ],
      actions: [
        { label: '复制', onClick: async () => { await navigator.clipboard.writeText(token); toast('已复制', 'success'); } },
        { label: '关闭', class: 'btn-primary' },
      ],
    });
  }

  // ---------- 弹窗 ----------

  function showModal({ title, subtitle, body, actions = [], wide = false }) {
    const root = $('#modal-root');
    clear(root);
    root.hidden = false;
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    const close = () => {
      root.hidden = true;
      clear(root);
      document.removeEventListener('keydown', onKey);
    };
    const actionNodes = actions.map((action) => el('button', {
      type: 'button', class: `btn ${action.class || ''}`, disabled: action.disabled,
      onClick: async () => {
        if (action.onClick) {
          try { await action.onClick(); }
          catch (error) { toast(error.message || '操作失败', 'error'); }
        } else close();
      },
    }, action.label));
    const modal = el('div', { class: `modal ${wide ? 'modal-wide' : ''}` },
      el('div', { class: 'modal-head' },
        el('div', {},
          el('h2', {}, title),
          subtitle ? el('p', {}, subtitle) : null),
        el('button', { class: 'modal-close', type: 'button', onClick: close, 'aria-label': '关闭' }, icon('x'))),
      el('div', { class: 'modal-body' }, body),
      actionNodes.length ? el('div', { class: 'modal-foot' }, actionNodes) : null);
    const overlay = el('div', {
      class: 'modal-overlay',
      onClick: (event) => { if (event.target === overlay) close(); },
    }, modal);
    root.append(overlay);
    document.addEventListener('keydown', onKey);
    return close;
  }

  // ---------- API ----------

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (state.me && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = state.me.csrf_token;
    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(path, { method, headers, body });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '');
    if (!response.ok) {
      const error = new Error(data && data.error && data.error.message ? data.error.message : `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.code = data && data.error ? data.error.code : undefined;
      if (response.status === 401 && !path.endsWith('/login')) {
        state.me = null;
        showLogin();
      }
      throw error;
    }
    return data;
  }

  const platform = (path, options = {}) => api(`/api/platform${path}`, options);
  const podcast = (path, options = {}) => api(`/api/podcast${path}`, options);
  const transcription = (path, options = {}) => api(`/api/transcription${path}`, options);

  async function loadApps(force = false) {
    if (state.apps.length && !force) return;
    try {
      const result = await platform('/apps');
      state.apps = result.apps || [];
    } catch {
      state.apps = [];
    }
  }

  function appName(appId) {
    const app = state.apps.find((entry) => entry.app_id === appId);
    return app ? app.display_name : appId;
  }

  // ---------- 登录与路由 ----------

  function showLogin() {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-password').value = '';
    $('#login-password').focus();
  }

  function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    const username = state.me ? state.me.username : 'owner';
    $('#current-user').textContent = username;
    const avatar = document.querySelector('.sidebar .avatar');
    if (avatar) avatar.textContent = username.slice(0, 1).toUpperCase();
  }

  async function login(event) {
    event.preventDefault();
    const errorNode = $('#login-error');
    errorNode.hidden = true;
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    try {
      const result = await api('/api/login', { method: 'POST', body: { username, password } });
      state.me = result;
      showApp();
      await loadApps(true);
      if (!location.hash || (!routes[location.hash.replace(/^#\/?/, '')] && !transcriptEpisodeId())) {
        history.replaceState(null, '', '#/overview');
      }
      await renderCurrent();
      toast(`已登录：${result.username}`, 'success');
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    }
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    state.me = null;
    state.apps = [];
    showLogin();
  }

  function transcriptEpisodeId() {
    const match = location.hash.match(/^#\/transcript\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function activeRoute() {
    if (transcriptEpisodeId()) return 'transcript';
    const route = location.hash.replace(/^#\/?/, '');
    return routes[route] ? route : 'overview';
  }

  function navigate(route) {
    if (location.hash === `#/${route}`) renderCurrent();
    else location.hash = `#/${route}`;
  }

  async function renderCurrent() {
    if (!state.me) return;
    const route = activeRoute();
    state.route = route;
    for (const button of document.querySelectorAll('#nav button[data-route]')) {
      button.classList.toggle('active', button.dataset.route === route);
    }
    $('#page-title').textContent = routes[route].title;
    $('#page-subtitle').textContent = routes[route].subtitle;
    $('#breadcrumb-current').textContent = routes[route].title;
    setPageActions();
    showLoading();
    try {
      await routes[route].render();
    } catch (error) {
      clear(content);
      content.append(el('div', { class: 'error-box' }, `加载失败：${error.message}`));
      toast(error.message || '加载失败', 'error');
    }
  }

  // ---------- 任务列表与详情 ----------

  function tasksTable(tasks) {
    if (!tasks.length) return emptyState('暂无任务', '提交任务或等待调度触发后会出现在这里。', 'tasks');
    const thead = el('thead', {}, el('tr', {},
      ['状态', '任务', '应用', '进度', '创建时间', '操作'].map((header) => el('th', {}, header))));
    const tbody = el('tbody', {}, tasks.map((task) => {
      const tr = el('tr', { class: 'clickable' }, [
        el('td', {}, badge(task.status)),
        el('td', { class: 'task-title' },
          el('div', { class: 'title-cell' },
            task.task_key,
            task.source === 'schedule' ? el('span', { class: 'pill source' }, '调度') : null),
          el('div', { class: 'sub' }, el('span', { class: 'id-chip' }, shortId(task.task_id)))),
        el('td', {}, appName(task.app_id)),
        el('td', {}, progressCell(task.progress, task.status)),
        el('td', { class: 'nowrap', title: fmtDateTime(task.created_at) }, fmtDate(task.created_at)),
        el('td', {}, actionButton('查看', 'arrow', (event) => {
          event.stopPropagation();
          openTask(task.task_id);
        }, 'btn btn-sm')),
      ]);
      tr.addEventListener('click', () => openTask(task.task_id));
      return tr;
    }));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, thead, tbody));
  }

  async function openTask(taskId) {
    const [task, events, logs, result] = await Promise.all([
      platform(`/tasks/${encodeURIComponent(taskId)}`),
      platform(`/tasks/${encodeURIComponent(taskId)}/events`),
      platform(`/tasks/${encodeURIComponent(taskId)}/logs`),
      platform(`/tasks/${encodeURIComponent(taskId)}/result`),
    ]);
    const close = showModal({
      title: `${task.task_key}`,
      subtitle: `${task.app_id} · ${shortId(task.task_id)}`,
      wide: true,
      body: [
        el('div', { class: 'toolbar' }, badge(task.status),
          el('span', { class: 'pill' }, `尝试 ${task.attempt_count}/${task.max_attempts}`),
          task.schedule_id ? el('span', { class: 'pill' }, `调度 ${shortId(task.schedule_id)}`) : null),
        kv([
          ['任务 ID', el('span', { class: 'mono' }, task.task_id)],
          ['创建', fmtDateTime(task.created_at)],
          ['更新', fmtDateTime(task.updated_at)],
          ['执行截止', task.deadline_at ? fmtDateTime(task.deadline_at) : '—'],
          ['关闭原因', task.close_reason || '—'],
          ['错误', task.error || '—'],
        ]),
        el('div', { class: 'section-title' }, '输入'),
        pre(task.input),
        el('div', { class: 'section-title' }, '输出'),
        pre(task.output || '（尚未产生输出）'),
        result.artifact_id
          ? el('div', {},
              el('span', { class: 'section-title' }, '产物'),
              el('a', { href: `/api/platform/artifacts/${encodeURIComponent(result.artifact_id)}/download`, target: '_blank', rel: 'noopener' }, '下载产物'))
          : null,
        el('div', { class: 'divider' }),
        el('div', { class: 'section-title' }, '事件'),
        events.events && events.events.length
          ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
              el('thead', {}, el('tr', {}, ['#', '类型', '内容', '时间'].map((h) => el('th', {}, h)))),
              el('tbody', {}, events.events.slice(-30).map((event) => el('tr', {},
                el('td', {}, String(event.id)), el('td', {}, event.type),
                el('td', { class: 'mono' }, JSON.stringify(event.payload)),
                el('td', { class: 'nowrap' }, fmtDate(event.created_at)))))))
          : emptyState('暂无事件'),
        el('div', { class: 'section-title' }, '日志'),
        logs.logs && logs.logs.length
          ? pre(logs.logs.map((log) => `[${fmtDate(log.created_at)}] ${log.level}: ${log.message}`).join('\n'))
          : el('p', { class: 'muted' }, '暂无日志'),
      ],
      actions: [
        ...(task.status === 'queued' || task.status === 'running' || task.status === 'recovering'
          ? [{
              label: '关闭任务', class: 'btn-danger',
              onClick: async () => {
                if (!window.confirm('确认关闭这个任务？Worker 的迟到写入会被拒绝。')) return;
                await platform(`/tasks/${encodeURIComponent(taskId)}/close`, { method: 'POST', body: { reason: 'Web 手动关闭' } });
                toast('任务已关闭', 'success');
                close();
                await renderCurrent();
              },
            }]
          : []),
        ...(task.status === 'failed' || task.status === 'closed'
          ? [{
              label: '重试', class: 'btn-primary',
              onClick: async () => {
                const created = await platform(`/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
                toast(`已创建重试任务 ${shortId(created.task_id)}`, 'success');
                close();
                navigate('tasks');
              },
            }]
          : []),
        { label: '刷新', onClick: async () => { close(); await openTask(taskId); } },
      ],
    });
    return close;
  }

  // ---------- 总览 ----------

  async function renderOverview() {
    setPageActions(actionButton('刷新', 'refresh', () => renderCurrent()));
    await loadApps();
    const [tasksData, schedulesData, podcastData, showsData] = await Promise.all([
      platform('/tasks?limit=20'),
      platform('/schedules'),
      podcast('/overview').catch(() => null),
      podcast('/shows').catch(() => null),
    ]);
    const tasks = tasksData.tasks || [];
    const schedules = schedulesData.schedules || [];
    const shows = showsData ? showsData.shows || [] : [];
    const running = tasks.filter((task) => task.status === 'running').length;
    const queued = tasks.filter((task) => task.status === 'queued').length;
    const enabledSchedules = schedules.filter((schedule) => schedule.enabled);
    const upcoming = enabledSchedules
      .filter((schedule) => schedule.next_fire_at)
      .sort((left, right) => Date.parse(left.next_fire_at) - Date.parse(right.next_fire_at));
    const hour = new Date().getHours();
    const greeting = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';
    const partial = podcastData ? podcastData.partial_shows : 0;

    clear(content);
    content.append(el('section', { class: 'hero' },
      el('div', { class: 'hero-copy' },
        el('span', { class: 'eyebrow light' }, 'PODCAST OPS · DAILY BRIEF'),
        el('h2', {}, `${greeting}，${state.me ? state.me.username : 'owner'}`),
        el('p', {}, `今天有 ${running} 个任务执行中、${queued} 个排队；播客库已收录 ${podcastData ? podcastData.shows : shows.length} 个节目、${podcastData ? podcastData.episodes : 0} 条单集。`),
        el('div', { class: 'hero-actions' },
          actionButton('打开节目库', 'mic', () => navigate('podcast-shows'), 'btn btn-primary'),
          actionButton('全部任务', 'tasks', () => navigate('tasks'), 'btn btn-on-dark'),
          actionButton('新建采集', 'plus', () => openCollectModal(), 'btn btn-on-dark'))),
      el('div', { class: 'hero-panel' },
        el('div', { class: 'hero-panel-head' }, el('span', {}, 'SYSTEM PULSE'), el('span', { class: 'dot green' })),
        el('div', { class: 'hero-row' }, el('span', {}, '已启用调度'), el('strong', {}, `${enabledSchedules.length} 个`)),
        el('div', { class: 'hero-row' }, el('span', {}, '最近触发'), el('strong', {}, upcoming[0] ? fmtRelative(upcoming[0].next_fire_at) : '—')),
        el('div', { class: 'hero-row' }, el('span', {}, '覆盖状态'), el('strong', {}, `${partial} 个 partial`)),
        el('div', { class: 'hero-row' }, el('span', {}, '存储'), el('strong', {}, 'SQLite WAL')))));

    if (podcastData && !podcastData.app_registered) {
      content.append(el('div', { class: 'notice notice-warn' },
        el('div', {}, el('strong', {}, '播客应用尚未注册'), el('div', { class: 'hint' }, '注册播客应用并启动 Podcast Worker 后，采集任务才会执行。')),
        actionButton('去注册', 'plus', () => navigate('apps'), 'btn btn-sm btn-primary')));
    }

    content.append(el('div', { class: 'stats-grid' },
      statCard('执行中', running, '最近 20 个任务', 'activity', 'amber'),
      statCard('排队', queued, '最近 20 个任务', 'clock', 'blue'),
      statCard('播客节目', podcastData ? podcastData.shows : '—', `${partial} 个不完整`, 'mic', 'green'),
      statCard('已入库单集', podcastData ? podcastData.episodes : '—', '仅列表元数据', 'layers', 'purple')));

    const recentCard = el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '最近任务'), el('div', { class: 'card-sub' }, '点击行查看事件、日志和结果')),
        el('button', { class: 'card-link', type: 'button', onClick: () => navigate('tasks') }, '全部任务', icon('arrow'))),
      el('div', { class: 'card-body flush' }, tasksTable(tasks.slice(0, 6))));

    const snapshot = shows.length
      ? el('div', { class: 'snapshot-list' }, shows.slice(0, 3).map((show) => el('div', { class: 'snapshot-row' },
          showCover(show),
          el('div', { class: 'snapshot-body' },
            el('div', { class: 'snapshot-title' }, show.title),
            el('div', { class: 'snapshot-meta' }, `${show.episode_count} 集 · ${show.coverage_status === 'full' ? '完整' : 'partial'}`)))))
      : emptyState('节目库为空', '添加节目后开始采集列表。', 'mic');
    const podcastCard = el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '播客库'), el('div', { class: 'card-sub' }, '最近纳入的节目')),
        el('button', { class: 'card-link', type: 'button', onClick: () => navigate('podcast-shows') }, '查看全部', icon('arrow'))),
      el('div', { class: 'card-body' }, snapshot));

    const scheduleList = upcoming.length
      ? el('div', { class: 'snapshot-list' }, upcoming.slice(0, 3).map((schedule) => el('div', { class: 'snapshot-row' },
          el('div', { class: 'snapshot-icon' }, icon('calendar')),
          el('div', { class: 'snapshot-body' },
            el('div', { class: 'snapshot-title' }, schedule.task_key),
            el('div', { class: 'snapshot-meta' }, `${schedule.cron} · ${fmtRelative(schedule.next_fire_at)}`)))))
      : emptyState('没有启用调度', '为节目同步创建每节目 schedule。', 'calendar');
    const scheduleCard = el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '即将触发'), el('div', { class: 'card-sub' }, '按 next_fire_at 排序')),
        el('button', { class: 'card-link', type: 'button', onClick: () => navigate('schedules') }, '调度配置', icon('arrow'))),
      el('div', { class: 'card-body' }, scheduleList));

    content.append(el('div', { class: 'dashboard-grid' }, recentCard,
      el('div', { class: 'side-stack' }, podcastCard, scheduleCard)));

    const steps = [
      ['01', '添加节目', '粘贴小宇宙公开节目链接，建立节目库。', () => navigate('podcast-shows'), '打开节目库'],
      ['02', '启动 Worker', '复制 Worker Token，启动 Podcast Worker。', () => navigate('apps'), '查看应用'],
      ['03', '设定节奏', '每节目一个 schedule，按周或按日自动同步。', () => navigate('schedules'), '配置调度'],
    ];
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '自动化链路'), el('div', { class: 'card-sub' }, '从节目链接到定时同步')),
        actionButton('节目库', 'mic', () => navigate('podcast-shows'), 'btn btn-sm')),
      el('div', { class: 'steps-grid' }, steps.map(([number, title, description, onClick, action]) => el('div', { class: 'step-card' },
        el('div', { class: 'step-number' }, number),
        el('div', { class: 'step-body' }, el('div', { class: 'step-title' }, title), el('div', { class: 'step-desc' }, description)),
        el('button', { class: 'card-link', type: 'button', onClick }, action, icon('arrow')))))));
  }

  // ---------- 任务页 ----------

  async function renderTasks() {
    await loadApps();
    const refresh = actionButton('刷新', 'refresh', () => renderTasks());
    setPageActions(refresh);
    const appSelect = el('select', { class: 'select', onChange: (event) => {
      state.taskFilters.app = event.target.value; renderTasks();
    } }, option('', '全部应用', !state.taskFilters.app),
      state.apps.map((app) => option(app.app_id, `${app.display_name}（${app.app_id}）`, state.taskFilters.app === app.app_id)));
    const statusSelect = el('select', { class: 'select', onChange: (event) => {
      state.taskFilters.status = event.target.value; renderTasks();
    } }, option('', '全部状态', !state.taskFilters.status),
      ['queued', 'running', 'recovering', 'succeeded', 'failed', 'closed'].map((status) =>
        option(status, STATUS_LABELS[status], state.taskFilters.status === status)));
    const params = new URLSearchParams({ limit: '50' });
    if (state.taskFilters.app) params.set('app_id', state.taskFilters.app);
    if (state.taskFilters.status) params.set('status', state.taskFilters.status);
    const data = await platform(`/tasks?${params.toString()}`);
    clear(content);
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '任务列表'), el('div', { class: 'card-sub' }, `${(data.tasks || []).length} 个任务`)),
        el('div', { class: 'toolbar' }, appSelect, statusSelect, refresh)),
      el('div', { class: 'card-body flush' }, tasksTable(data.tasks || []))));
  }

  // ---------- 应用页 ----------

  async function renderApps() {
    setPageActions(
      actionButton('刷新', 'refresh', () => renderApps()),
      actionButton('注册 / 更新应用', 'plus', openRegisterApp, 'btn btn-primary'));
    await loadApps(true);
    const details = await Promise.all(state.apps.map(async (app) => {
      try {
        const data = await platform(`/apps/${encodeURIComponent(app.app_id)}/tasks`);
        return { ...app, tasks: data.tasks || [] };
      } catch {
        return { ...app, tasks: [] };
      }
    }));
    clear(content);
    if (!details.length) {
      content.append(el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('div', {}, el('div', { class: 'card-title' }, '应用'), el('div', { class: 'card-sub' }, '还没有注册应用'))),
        el('div', { class: 'card-body' }, emptyState('没有应用', '先注册一个应用 manifest，再启动 Worker。', 'app'))));
      return;
    }
    content.append(el('div', { class: 'app-grid' }, details.map((app) => el('section', { class: 'card app-card' },
      el('div', { class: `app-logo ${app.app_id === 'podcast-tools' ? 'alt' : ''}` }, (app.display_name || app.app_id).slice(0, 1).toUpperCase()),
      el('div', { class: 'app-body' },
        el('div', { class: 'app-name' }, app.display_name),
        el('div', { class: 'app-id' }, app.app_id),
        el('div', { class: 'app-meta' },
          el('span', { class: 'pill' }, `${app.tasks.length} 个任务`),
          el('span', { class: 'pill' }, `并发 ${app.max_concurrency}`),
          app.app_id === 'podcast-tools' ? el('span', { class: 'pill source' }, '播客') : null),
        el('div', { class: 'app-actions' },
          actionButton('任务定义', 'layers', () => openAppDefinitions(app.app_id), 'btn btn-sm'),
          actionButton('轮换 Token', 'refresh', () => rotateToken(app.app_id), 'btn btn-sm'))))),
      el('button', { class: 'card app-add', type: 'button', onClick: openRegisterApp },
        el('div', { class: 'app-add-icon' }, icon('plus')),
        el('div', {}, el('div', { class: 'app-name' }, '注册新应用'), el('div', { class: 'app-id' }, '粘贴 manifest JSON，覆盖更新任务定义')))));
  }

  function openRegisterApp() {
    const textarea = el('textarea', { class: 'textarea', rows: 14, placeholder: '粘贴应用 manifest JSON' });
    const close = showModal({
      title: '注册 / 更新应用',
      subtitle: '会覆盖更新任务定义，不保留版本；新应用会返回一次性 Worker Token',
      body: [
        el('div', { class: 'toolbar' },
          el('button', { class: 'btn btn-sm', type: 'button', onClick: async () => {
            try {
              const data = await podcast('/manifest');
              textarea.value = JSON.stringify(data.manifest, null, 2);
              toast('已填入播客 manifest', 'success');
            } catch (error) { toast(error.message, 'error'); }
          } }, '填入播客 manifest')),
        textarea,
        el('div', { class: 'hint' }, 'JSON 必须包含 app_id、display_name、tasks；任务输入/输出 schema 使用内置子集。'),
      ],
      actions: [
        { label: '取消', onClick: close },
        {
          label: '注册 / 更新', class: 'btn-primary',
          onClick: async () => {
            let manifest;
            try { manifest = JSON.parse(textarea.value); }
            catch { throw new Error('manifest 不是有效 JSON'); }
            const result = await platform('/apps', { method: 'POST', body: manifest });
            if (result.worker_token) {
              close();
              showTokenModal(`Worker Token · ${manifest.app_id}`, result.worker_token);
            } else {
              toast('应用已更新（已有 Worker Token 未变）', 'success');
              close();
            }
            await loadApps(true);
            await renderCurrent();
          },
        },
      ],
    });
  }

  async function openAppDefinitions(appId) {
    const data = await platform(`/apps/${encodeURIComponent(appId)}/tasks`);
    const tasks = data.tasks || [];
    showModal({
      title: `任务定义 · ${appId}`,
      wide: true,
      body: tasks.length ? table(['任务', '显示名', '可调度', '排队超时', '执行超时'], tasks.map((task) => [
        el('span', { class: 'mono' }, task.task_key),
        task.display_name,
        task.schedulable ? '是' : '否',
        `${Math.round(task.queue_timeout_ms / 60000)} 分钟`,
        `${Math.round(task.execution_timeout_ms / 60000)} 分钟`,
      ])) : emptyState('没有启用的任务定义'),
    });
  }

  async function rotateToken(appId) {
    if (!window.confirm(`轮换 ${appId} 的 Worker Token？旧 Token 立即失效。`)) return;
    const result = await platform(`/apps/${encodeURIComponent(appId)}/worker-token`, { method: 'POST' });
    showTokenModal(`新的 Worker Token · ${appId}`, result.worker_token);
  }

  // ---------- 调度页 ----------

  async function renderSchedules() {
    await loadApps();
    setPageActions(
      actionButton('刷新', 'refresh', () => renderSchedules()),
      actionButton('新建调度', 'plus', openCreateSchedule, 'btn btn-primary'));
    const [data, showsData] = await Promise.all([
      platform('/schedules'),
      podcast('/shows').catch(() => ({ shows: [] })),
    ]);
    const schedules = data.schedules || [];
    const showTitles = new Map((showsData.shows || []).map((show) => [show.show_id, show.title]));
    clear(content);
    const tableNode = schedules.length ? table(['任务', 'cron / 时区', '下次触发', '状态', '操作'], schedules.map((schedule) => {
      const showId = schedule.input && typeof schedule.input === 'object' ? schedule.input.show_id : null;
      const showTitle = showId ? showTitles.get(showId) : null;
      return [
        el('div', {},
          el('div', { class: 'title-cell' }, showTitle || schedule.task_key),
          el('div', { class: 'sub' }, `${schedule.app_id}/${schedule.task_key}`),
          el('div', { class: 'sub' }, el('span', { class: 'id-chip' }, shortId(schedule.schedule_id)))),
        el('div', {},
          el('span', { class: 'cron' }, schedule.cron),
          el('div', { class: 'schedule-zone' }, schedule.timezone)),
        el('div', { class: 'schedule-next' },
          schedule.enabled ? fmtRelative(schedule.next_fire_at) : '—',
          el('div', { class: 'schedule-zone' }, schedule.enabled ? fmtDateTime(schedule.next_fire_at) : '已停用')),
        el('div', { class: 'toolbar' },
          el('button', {
            class: `switch ${schedule.enabled ? 'on' : ''}`, type: 'button',
            title: schedule.enabled ? '停用调度' : '启用调度',
            onClick: () => toggleSchedule(schedule),
          })),
        el('div', { class: 'row-actions' },
          actionButton('run-now', 'play', () => runSchedule(schedule.schedule_id), 'btn btn-sm'),
          actionButton('历史', 'clock', () => openScheduleRuns(schedule.schedule_id), 'btn btn-sm'),
          actionButton('删除', 'x', () => deleteSchedule(schedule.schedule_id), 'btn btn-sm btn-danger')),
      ];
    })) : emptyState('还没有调度', '为节目同步或任意可调度任务创建 cron。', 'calendar');
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '调度列表'), el('div', { class: 'card-sub' }, `${schedules.length} 个调度`)),
        actionButton('刷新', 'refresh', () => renderSchedules(), 'btn btn-sm')),
      el('div', { class: 'card-body flush' }, tableNode)));
  }

  function openCreateSchedule() {
    const appSelect = el('select', { class: 'select' }, state.apps.map((app) =>
      option(app.app_id, `${app.display_name}（${app.app_id}）`)));
    const taskSelect = el('select', { class: 'select' });
    const cron = el('input', { class: 'input', value: '0 9 * * *' });
    const timezone = el('input', { class: 'input', value: 'Asia/Shanghai' });
    const input = el('textarea', { class: 'textarea', rows: 5 }, '{}');
    const enabled = el('input', { type: 'checkbox', checked: true });
    const hint = el('div', { class: 'hint' }, 'cron 5 字段：分 时 日 月 周；时区使用 IANA 名称。');
    async function fillTasks() {
      clear(taskSelect);
      if (!appSelect.value) return;
      try {
        const data = await platform(`/apps/${encodeURIComponent(appSelect.value)}/tasks`);
        const schedulable = (data.tasks || []).filter((task) => task.schedulable);
        for (const task of schedulable) taskSelect.append(option(task.task_key, `${task.display_name}（${task.task_key}）`));
        if (!schedulable.length) taskSelect.append(option('', '该应用没有可调度任务', true));
      } catch (error) { toast(error.message, 'error'); }
    }
    appSelect.addEventListener('change', fillTasks);
    const close = showModal({
      title: '新建调度',
      body: [
        el('div', { class: 'form-grid' },
          el('label', { class: 'field' }, el('span', {}, '应用'), appSelect),
          el('label', { class: 'field' }, el('span', {}, '任务'), taskSelect),
          el('label', { class: 'field' }, el('span', {}, 'cron'), cron),
          el('label', { class: 'field' }, el('span', {}, '时区'), timezone),
          el('label', { class: 'field span-2' }, el('span', {}, '固定输入 JSON'), input),
          el('label', { class: 'checkbox span-2' }, enabled, '创建后立即启用')),
        hint,
      ],
      actions: [
        { label: '取消', onClick: close },
        {
          label: '创建', class: 'btn-primary',
          onClick: async () => {
            if (!appSelect.value || !taskSelect.value) throw new Error('请选择应用和任务');
            let parsed;
            try { parsed = JSON.parse(input.value || '{}'); }
            catch { throw new Error('调度输入不是有效 JSON'); }
            await platform('/schedules', { method: 'POST', body: {
              app_id: appSelect.value, task_key: taskSelect.value,
              input: parsed, cron: cron.value.trim(), timezone: timezone.value.trim(), enabled: enabled.checked,
            } });
            toast('调度已创建', 'success');
            close();
            await renderSchedules();
          },
        },
      ],
    });
    fillTasks();
  }

  async function runSchedule(scheduleId) {
    const result = await platform(`/schedules/${encodeURIComponent(scheduleId)}/run-now`, { method: 'POST' });
    if (result.skipped) toast(`已跳过：${result.skipped}`, 'error');
    else toast(`已创建任务 ${shortId(result.task?.task_id)}`, 'success');
    await renderCurrent();
  }

  async function toggleSchedule(schedule) {
    await platform(`/schedules/${encodeURIComponent(schedule.schedule_id)}`, {
      method: 'PATCH', body: { enabled: !schedule.enabled },
    });
    toast(schedule.enabled ? '调度已停用' : '调度已启用', 'success');
    await renderSchedules();
  }

  async function deleteSchedule(scheduleId) {
    if (!window.confirm('确认删除这个调度？历史任务会保留。')) return;
    await platform(`/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
    toast('调度已删除', 'success');
    await renderSchedules();
  }

  async function openScheduleRuns(scheduleId) {
    const data = await platform(`/schedules/${encodeURIComponent(scheduleId)}/runs`);
    const runs = data.runs || [];
    showModal({
      title: '调度运行历史',
      wide: true,
      body: runs.length ? table(['计划时间', '状态', '任务', '原因'], runs.map((run) => [
        fmtDateTime(run.planned_fire_time), badge(run.status),
        run.task_id ? el('span', { class: 'mono' }, shortId(run.task_id)) : '—',
        run.reason || '—',
      ])) : emptyState('还没有运行记录'),
    });
  }

  // ---------- 播客 ----------

  async function loadPodcastOverview() {
    return podcast('/overview');
  }

  async function renderPodcastShows() {
    setPageActions(
      actionButton('刷新', 'refresh', () => renderPodcastShows()),
      actionButton('采集两年', 'layers', () => openCollectModal(), 'btn'),
      actionButton('添加节目', 'plus', openAddShow, 'btn btn-primary'));
    const [overview, showsData, runsData] = await Promise.all([
      loadPodcastOverview(),
      podcast('/shows'),
      podcast('/runs').catch(() => ({ runs: [] })),
    ]);
    const shows = showsData.shows || [];
    const runs = runsData.runs || [];
    clear(content);

    if (!overview.app_registered) {
      content.append(el('div', { class: 'notice notice-warn' },
        el('div', {},
          el('strong', {}, '播客应用尚未注册'),
          el('div', { class: 'hint' }, '注册后会获得一次性 Worker Token；启动 Podcast Worker 才能执行采集。')),
        el('div', { class: 'row-actions' },
          actionButton('注册播客应用', 'plus', registerPodcastApp, 'btn btn-sm btn-primary'),
          actionButton('去应用页', 'app', () => navigate('apps'), 'btn btn-sm'))));
    }

    if (overview.transcription_app_registered === false) {
      content.append(el('div', { class: 'notice' },
        el('div', {}, el('strong', {}, '转写应用尚未注册'), el('div', { class: 'hint' }, '注册后可启动 Transcription Worker，对单集生成文字稿。')),
        el('div', { class: 'row-actions' },
          actionButton('注册转写应用', 'plus', registerTranscriptionApp, 'btn btn-sm btn-primary'),
          actionButton('去应用页', 'app', () => navigate('apps'), 'btn btn-sm'))));
    }

    content.append(el('div', { class: 'stats-grid' },
      statCard('节目', overview.shows, `${overview.partial_shows} 个不完整`, 'mic', 'green'),
      statCard('单集', overview.episodes, '列表元数据', 'layers', 'blue'),
      statCard('播客应用', overview.app_registered ? '已注册' : '未注册', overview.app_id, 'app', 'purple'),
      statCard('最近采集', overview.last_run_at ? fmtRelative(overview.last_run_at) : '—', '仅列表，无音频', 'clock', 'amber')));

    const search = el('input', { class: 'input', placeholder: '搜索节目、作者或链接' });
    const rows = shows.map((show) => [
      el('input', {
        type: 'checkbox', checked: state.selectedShowIds.has(show.show_id),
        'aria-label': `选择 ${show.title}`,
        onChange: (event) => {
          if (event.target.checked) state.selectedShowIds.add(show.show_id);
          else state.selectedShowIds.delete(show.show_id);
        },
      }),
      el('div', { class: 'show-cell' },
        showCover(show),
        el('div', { style: 'min-width:0' },
          el('div', { class: 'show-title' }, show.title),
          el('div', { class: 'show-author' }, show.author || '未知作者'),
          el('div', { class: 'sub' },
            show.rss_url ? el('span', { class: 'pill source' }, 'RSS') : el('span', { class: 'pill' }, '公开页'),
            el('a', { class: 'show-link', href: show.url, target: '_blank', rel: 'noopener', title: show.url }, show.url)))),
      el('div', {},
        el('div', { class: 'title-cell' }, `已入库 ${show.episode_count} 集`),
        el('div', { class: 'sub' }, show.rss_url
          ? `RSS 共 ${show.total_episode_count ?? show.page_episode_count ?? '—'} 集`
          : (show.page_episode_count || show.total_episode_count
            ? `页面 ${show.page_episode_count ?? '—'} / 总计 ${show.total_episode_count ?? '—'}` : '尚未同步'))),
      el('div', {}, coverageBar(show), badge(show.coverage_status === 'full' ? 'full' : show.coverage_status === 'unknown' ? 'unknown' : 'partial')),
      el('div', {},
        el('div', {}, show.last_sync_at ? fmtDateTime(show.last_sync_at) : '—'),
        el('div', { class: 'sub' }, show.last_sync_status ? (STATUS_LABELS[show.last_sync_status] || show.last_sync_status) : '未同步'),
        show.last_error ? el('div', { class: 'sub', title: show.last_error, style: 'color:var(--red)' }, '最近一次有错误') : null),
      el('div', { class: 'row-actions' },
        iconAction('同步', 'refresh', () => syncShow(show.show_id)),
        iconAction('查看单集', 'layers', () => openEpisodes(show)),
        iconAction('定时同步', 'calendar', () => openShowSchedule(show)),
        iconAction('采集记录', 'clock', () => openShowRuns(show))),
    ]);
    const tableNode = shows.length
      ? table(['', '节目', '单集', '覆盖', '最近同步', '操作'], rows)
      : emptyState('还没有节目', '添加一个小宇宙节目链接，或直接粘贴节目 URL。', 'mic');

    if (shows.length) {
      const trs = [...tableNode.querySelectorAll('tbody tr')];
      trs.forEach((tr, index) => {
        tr.dataset.search = `${shows[index].title} ${shows[index].author || ''} ${shows[index].url}`.toLowerCase();
      });
      search.addEventListener('input', () => {
        const keyword = search.value.trim().toLowerCase();
        for (const tr of trs) tr.hidden = keyword.length > 0 && !tr.dataset.search.includes(keyword);
      });
    }

    const selectedCount = state.selectedShowIds.size;
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {},
          el('div', { class: 'card-title' }, '节目库'),
          el('div', { class: 'card-sub' }, selectedCount ? `已选 ${selectedCount} 个节目，可在采集弹窗中批量提交` : '选择节目后可批量采集')),
        el('div', { class: 'toolbar' }, search)),
      el('div', { class: 'card-body flush' }, tableNode)));

    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('div', {}, el('div', { class: 'card-title' }, '采集规则'), el('div', { class: 'card-sub' }, '当前只抓列表元数据，不下载音频'))),
      el('div', { class: 'card-body' },
        el('div', { class: 'hint' },
          '有 RSS 时优先使用 RSS 全量列表；没有 RSS 时回退公开页，通常只有 15 集并标记 partial。',
          el('br'),
          'Worker 必须使用 Worker Token 启动；Web 浏览器不会看到平台 Owner Token。'))));

    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '最近采集'), el('div', { class: 'card-sub' }, '跨节目的最近运行记录')),
        el('button', { class: 'card-link', type: 'button', onClick: () => navigate('podcast-tasks') }, '查看任务', icon('arrow'))),
      el('div', { class: 'card-body flush' }, runs.length ? table(['时间', '节目', '状态', '区间', '新增 / 更新', '错误'], runs.map((run) => [
        el('span', { class: 'nowrap' }, fmtDateTime(run.started_at)),
        el('div', {}, el('div', { class: 'title-cell' }, run.show_title || '—'), el('div', { class: 'sub' }, run.show_id ? shortId(run.show_id) : '—')),
        badge(run.status),
        el('span', { class: 'nowrap' }, `${run.since || '—'} → ${run.until || '—'}`),
        el('span', { class: 'nowrap' }, `${run.inserted_count} / ${run.updated_count}`),
        run.error ? el('span', { title: run.error, style: 'color:var(--red)' }, '有错误') : '—',
      ])) : emptyState('还没有采集记录', '同步节目后会在这里显示每次运行结果。', 'clock'))));
  }

  function queueBadge(status) {
    const map = {
      pending: ['queued', '待转写'],
      running: ['running', '运行中'],
      done: ['succeeded', '已完成'],
      failed: ['failed', '失败'],
      canceled: ['closed', '已取消'],
    };
    const [className, label] = map[status] || ['unknown', status || '未知'];
    return el('span', { class: `badge badge-${className}` }, label);
  }

  async function queueAction(action, successMessage) {
    try {
      await transcription(`/queue/${action}`, { method: 'POST' });
      toast(successMessage, 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
    await renderTranscribeQueue();
  }

  async function queueItem(id, action, body) {
    try {
      const method = action === 'delete' ? 'DELETE' : 'POST';
      const path = action === 'delete'
        ? `/queue/${encodeURIComponent(id)}`
        : action === 'retry'
          ? `/queue/${encodeURIComponent(id)}/retry`
          : `/queue/${encodeURIComponent(id)}/move`;
      await transcription(path, { method, body: body || undefined });
      toast(action === 'delete' ? '已移除' : action === 'retry' ? '已重新入队' : '已调整顺序', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
    await renderTranscribeQueue();
  }

  async function renderTranscribeQueue() {
    setPageActions(actionButton('刷新', 'refresh', () => renderTranscribeQueue()));
    const [data, transcriptData] = await Promise.all([
      transcription('/queue'),
      transcription('/transcripts').catch(() => ({ transcripts: [] })),
    ]);
    const items = data.items || [];
    const counts = data.counts || {};
    const transcripts = transcriptData.transcripts || [];
    clear(content);
    content.append(el('div', { class: 'stats-grid' },
      statCard('待转写', counts.pending || 0, '按队列顺序执行', 'layers', 'blue'),
      statCard('运行中', counts.running || 0, data.runner ? '队列已启动' : '尚未启动', 'play', 'green'),
      statCard('已完成', counts.done || 0, '可清空', 'check', 'purple'),
      statCard('失败', counts.failed || 0, '可重试', 'alert', 'amber')));

    if (data.error) {
      content.append(el('div', { class: 'notice notice-warn' },
        el('div', {}, el('strong', {}, '队列已暂停'), el('div', { class: 'hint' }, data.error))));
    }

    const toolbar = el('div', { class: 'row-actions' },
      data.paused
        ? actionButton('开始队列', 'play', () => queueAction('start', '队列已启动'), 'btn btn-primary')
        : actionButton('暂停队列', 'x', () => queueAction('pause', '队列已暂停'), 'btn'),
      actionButton('清空已结束', 'x', () => queueAction('clear', '已清理结束项'), 'btn btn-sm'),
      actionButton('去节目库选单集', 'mic', () => navigate('podcast-shows'), 'btn btn-sm'));

    const rows = items.map((item, index) => [
      el('span', { class: 'nowrap' }, index + 1),
      el('input', {
        type: 'checkbox', checked: item.enabled, disabled: item.status === 'running',
        'aria-label': `启用 ${item.title}`,
        onChange: async (event) => {
          await transcription(`/queue/${encodeURIComponent(item.id)}`, {
            method: 'PATCH', body: { enabled: event.target.checked },
          });
          toast(event.target.checked ? '已启用' : '已停用', 'success');
        },
      }),
      el('div', {},
        el('div', { class: 'title-cell' }, item.title),
        el('div', { class: 'sub' }, shortId(item.show_id))),
      el('div', {},
        queueBadge(item.status),
        item.status === 'running' ? progressCell(item.progress, 'running') : null,
        item.error ? el('div', { class: 'sub', style: 'color:var(--red)', title: item.error },
          String(item.error).slice(0, 80)) : null),
      el('div', { class: 'row-actions' },
        actionButton('上移', 'arrow', () => queueItem(item.id, 'move', { direction: 'up' }), 'btn btn-sm'),
        actionButton('下移', 'arrow', () => queueItem(item.id, 'move', { direction: 'down' }), 'btn btn-sm'),
        item.status === 'failed'
          ? actionButton('重试', 'refresh', () => queueItem(item.id, 'retry', null), 'btn btn-sm')
          : null,
        item.status === 'running'
          ? null
          : actionButton('移除', 'x', () => queueItem(item.id, 'delete', null), 'btn btn-sm')),
    ]);

    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '转写队列'),
          el('div', { class: 'card-sub' }, `共 ${items.length} 项；Web 负责选择与顺序，Worker 只执行平台下发的任务`)),
        toolbar),
      el('div', { class: 'card-body flush' },
        items.length ? table(['#', '启用', '单集', '状态', '顺序 / 操作'], rows)
          : emptyState('队列为空', '去节目库打开单集，勾选后加入转写队列。', 'mic'))));

    const transcriptRows = transcripts.map((transcript) => [
      el('div', {},
        el('div', { class: 'title-cell' }, transcript.title || '（无标题）'),
        el('div', { class: 'sub' }, shortId(transcript.episode_id))),
      transcript.show_title || shortId(transcript.show_id),
      fmtDuration(transcript.duration_seconds),
      `${transcript.segments || 0} 段`,
      `${transcript.provider || '—'} / ${transcript.model || '—'}`,
      fmtDateTime(transcript.created_at),
      el('div', { class: 'row-actions' },
        transcript.episode_id
          ? actionButton('查看转写稿', 'tasks',
            () => navigate(`transcript/${encodeURIComponent(transcript.episode_id)}`), 'btn btn-sm')
          : null),
    ]);

    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '已入库转写稿'),
          el('div', { class: 'card-sub' }, '转写成功并写入服务端数据库的结果')),
        null),
      el('div', { class: 'card-body flush' },
        transcripts.length
          ? table(['单集', '节目', '时长', '片段', '引擎', '完成时间', '操作'], transcriptRows)
          : emptyState('还没有入库的转写稿', '队列完成一集后会自动写入这里。', 'tasks'))));
  }

  function openAddShow() {
    const url = el('input', { class: 'input', placeholder: 'https://www.xiaoyuzhoufm.com/podcast/...' });
    const title = el('input', { class: 'input', placeholder: '可留空，同步时自动填充' });
    const rss = el('input', { class: 'input', placeholder: '可选；填写后优先使用 RSS 全量列表' });
    const close = showModal({
      title: '添加节目',
      subtitle: '先入库，随后点击同步抓取公开页列表',
      body: [
        el('label', { class: 'field' }, el('span', {}, '节目链接'), url),
        el('label', { class: 'field' }, el('span', {}, '标题（可选）'), title),
        el('label', { class: 'field' }, el('span', {}, 'RSS（可选）'), rss),
        el('div', { class: 'hint' }, '请使用小宇宙公开节目页链接；其他站点当前解析会失败。'),
      ],
      actions: [
        { label: '取消', onClick: close },
        {
          label: '保存', class: 'btn-primary',
          onClick: async () => {
            if (!url.value.trim()) throw new Error('请填写节目链接');
            await podcast('/shows', { method: 'POST', body: {
              url: url.value.trim(), title: title.value.trim() || undefined, rss_url: rss.value.trim() || undefined,
            } });
            toast('节目已添加，可点击同步采集列表', 'success');
            close();
            await renderPodcastShows();
          },
        },
      ],
    });
  }

  async function registerPodcastApp() {
    const result = await podcast('/register', { method: 'POST' });
    if (result.worker_token) showTokenModal('播客 Worker Token', result.worker_token);
    else toast('播客应用已存在，请到应用页轮换 Token', 'success');
    await loadApps(true);
    await renderPodcastShows();
  }

  async function syncShow(showId) {
    const result = await podcast(`/shows/${encodeURIComponent(showId)}/sync`, { method: 'POST', body: {} });
    toast(`已提交同步任务 ${shortId(result.task?.task_id)}`, 'success');
  }

  function openCollectModal(preselected) {
    const selected = preselected instanceof Set ? [...preselected] : [...state.selectedShowIds];
    const since = el('input', { class: 'input', type: 'date', value: defaultSince() });
    const until = el('input', { class: 'input', type: 'date', value: today() });
    const close = showModal({
      title: '采集播客列表',
      subtitle: selected.length ? `已选 ${selected.length} 个节目` : '将采集全部已添加节目',
      body: [
        el('div', { class: 'form-grid' },
          el('label', { class: 'field' }, el('span', {}, '开始日期'), since),
          el('label', { class: 'field' }, el('span', {}, '结束日期'), until)),
        el('div', { class: 'notice notice-warn' },
          el('span', {}, '公开页只有最近 15 集；没有 RSS 的节目会标记为 partial，不会伪造两年完整数据。')),
        el('div', { class: 'hint' }, '任务只抓列表元数据，不下载音频；完成后到“采集任务”查看状态。'),
      ],
      actions: [
        { label: '取消', onClick: close },
        {
          label: '提交采集', class: 'btn-primary',
          onClick: async () => {
            const body = { since: since.value, until: until.value };
            if (selected.length) body.show_ids = selected;
            const result = await podcast('/collect', { method: 'POST', body });
            toast(`已提交采集任务 ${shortId(result.task?.task_id)}`, 'success');
            close();
            navigate('podcast-tasks');
          },
        },
      ],
    });
  }

  async function openEpisodes(show) {
    const data = await podcast(`/shows/${encodeURIComponent(show.show_id)}/episodes?limit=200`);
    const episodes = data.episodes || [];
    const selected = new Set();
    const rowChecks = [];

    const counter = el('span', { class: 'hint' }, '勾选单集后加入队列');
    const addButton = actionButton('加入转写队列', 'plus', async () => {
      if (selected.size === 0) return;
      try {
        const result = await transcription('/queue', {
          method: 'POST', body: { episode_ids: [...selected] },
        });
        toast(`已加入 ${result.added} 集${result.skipped ? `，跳过 ${result.skipped} 集` : ''}`, 'success');
        closeModal();
        if (state.route === 'transcribe-queue') await renderTranscribeQueue();
      } catch (error) {
        toast(error.message, 'error');
      }
    }, 'btn btn-sm btn-primary');
    addButton.disabled = true;

    const syncSelection = () => {
      addButton.disabled = selected.size === 0;
      counter.textContent = selected.size ? `已选 ${selected.size} 集` : '勾选单集后加入队列';
    };

    const selectAll = el('input', {
      type: 'checkbox', 'aria-label': '全选本页',
      onChange: (event) => {
        selected.clear();
        for (const checkbox of rowChecks) {
          checkbox.checked = event.target.checked;
          if (event.target.checked) selected.add(checkbox.dataset.episodeId);
        }
        syncSelection();
      },
    });

    const toolbar = el('div', { class: 'toolbar' },
      el('label', { class: 'checkbox-row' }, selectAll, el('span', {}, '全选本页')),
      counter, addButton);

    const rows = episodes.map((episode) => {
      const checkbox = el('input', {
        type: 'checkbox', 'aria-label': `选择 ${episode.title}`, dataset: { episodeId: episode.episode_id },
        onChange: (event) => {
          if (event.target.checked) selected.add(episode.episode_id);
          else selected.delete(episode.episode_id);
          syncSelection();
        },
      });
      rowChecks.push(checkbox);
      return [
        checkbox,
        el('div', {},
          el('div', { class: 'title-cell' }, episode.title),
          episode.description ? el('div', { class: 'sub' }, String(episode.description).slice(0, 110)) : null),
        fmtDateTime(episode.published_at),
        fmtDuration(episode.duration_seconds),
        episode.source,
        el('div', { class: 'row-actions' },
          actionButton('转写', 'mic', () => transcribeEpisode(episode), 'btn btn-sm'),
          actionButton('转写稿', 'tasks', () => openTranscript(episode), 'btn btn-sm')),
      ];
    });

    const body = el('div', {},
      toolbar,
      episodes.length
        ? table(['', '标题', '发布时间', '时长', '来源', '操作'], rows)
        : emptyState('还没有单集', '点击同步后按日期范围入库。', 'mic'));

    let closeModal = () => {};
    closeModal = showModal({
      title: `单集 · ${show.title}`,
      subtitle: `${episodes.length} 条已入库；勾选后加入 Web 转写队列`,
      wide: true,
      body,
    });
  }

  async function transcribeEpisode(episode) {
    if (!episode.audio_url) {
      toast('该单集没有音频地址', 'error');
      return;
    }
    const result = await transcription('/queue', {
      method: 'POST', body: { episode_ids: [episode.episode_id] },
    });
    await transcription('/queue/start', { method: 'POST' });
    toast(`已加入转写队列${result.added ? '并开始' : '（已存在）'}`, 'success');
    if (state.route === 'transcribe-queue') await renderTranscribeQueue();
  }

  function appendInline(parent, text) {
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) parent.append(document.createTextNode(text.slice(cursor, index)));
      const token = match[0];
      if (token.startsWith('**')) {
        parent.append(el('strong', {}, token.slice(2, -2)));
      } else if (token.startsWith('*')) {
        parent.append(el('em', {}, token.slice(1, -1)));
      } else if (token.startsWith('`')) {
        parent.append(el('code', {}, token.slice(1, -1)));
      } else {
        const split = token.indexOf('](');
        const label = token.slice(1, split);
        const href = token.slice(split + 2, -1);
        parent.append(el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label));
      }
      cursor = index + token.length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function renderMarkdown(markdown) {
    const root = el('div', { class: 'markdown' });
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list = null;
    let listType = null;
    let code = [];
    let inCode = false;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const node = el('p', {});
      appendInline(node, paragraph.join(' '));
      root.append(node);
      paragraph = [];
    };
    const flushList = () => {
      if (list) root.append(list);
      list = null;
      listType = null;
    };
    const flush = () => { flushParagraph(); flushList(); };
    const startList = (type) => {
      if (list && listType !== type) flushList();
      if (!list) {
        list = el(type === 'ol' ? 'ol' : 'ul', {});
        listType = type;
      }
    };

    for (const source of lines) {
      const line = source.trimEnd();
      if (inCode) {
        if (line.trim().startsWith('```')) {
          root.append(el('pre', {}, el('code', {}, code.join('\n'))));
          code = [];
          inCode = false;
        } else {
          code.push(source);
        }
        continue;
      }
      if (line.trim().startsWith('```')) {
        flush();
        inCode = true;
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length + 1, 6);
        const node = el(`h${level}`, {});
        appendInline(node, heading[2]);
        root.append(node);
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flush();
        root.append(el('hr', {}));
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        startList('ul');
        const item = el('li', {});
        appendInline(item, bullet[1]);
        list.append(item);
        continue;
      }
      const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ordered) {
        startList('ol');
        const item = el('li', {});
        appendInline(item, ordered[1]);
        list.append(item);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flush();
        const quote = el('blockquote', {});
        appendInline(quote, line.replace(/^\s*>\s?/, ''));
        root.append(quote);
        continue;
      }
      paragraph.push(line.trim());
    }
    flush();
    if (inCode) root.append(el('pre', {}, el('code', {}, code.join('\n'))));
    return root;
  }

  async function renderTranscript() {
    const episodeId = transcriptEpisodeId();
    const back = actionButton('返回节目库', 'grid', () => navigate('podcast-shows'));
    setPageActions(back);
    if (!episodeId) {
      clear(content);
      content.append(emptyState('转写稿不存在', '请从节目库的单集进入。', 'mic'));
      return;
    }
    const data = await podcast(`/episodes/${encodeURIComponent(episodeId)}/transcript`);
    const transcript = data.transcript;
    clear(content);
    if (!transcript) {
      content.append(emptyState('还没有转写稿', '回到节目库，打开单集后点击“转写”。', 'mic'));
      return;
    }
    setPageActions(
      back,
      actionButton('复制原文', 'tasks', async () => {
        try { await navigator.clipboard.writeText(transcript.text); toast('已复制转写原文', 'success'); }
        catch { toast('复制失败，请手动选择文本', 'error'); }
      }),
    );
    content.append(el('div', { class: 'transcript-page' },
      el('div', { class: 'transcript-head' },
        el('div', { class: 'eyebrow' }, 'TRANSCRIPT'),
        el('h2', { class: 'transcript-title' }, transcript.title || '转写稿'),
        el('div', { class: 'transcript-meta' },
          pill(transcript.language || 'unknown'),
          pill(`${transcript.provider || 'unknown'} / ${transcript.model || 'unknown'}`),
          pill(fmtDuration(transcript.duration_seconds)),
          pill(`${(transcript.segments || []).length} 个片段`),
          el('span', { class: 'hint' }, fmtDateTime(transcript.created_at)))),
      el('section', { class: 'card transcript-card' }, renderMarkdown(transcript.text))));
  }

  async function openTranscript(episode) {
    if (!episode?.episode_id) {
      toast('缺少单集 ID', 'error');
      return;
    }
    navigate(`transcript/${encodeURIComponent(episode.episode_id)}`);
  }

  async function registerTranscriptionApp() {
    const result = await api('/api/transcription/register', { method: 'POST' });
    if (result.worker_token) showTokenModal('转写 Worker Token', result.worker_token);
    else toast('转写应用已存在，请到应用页轮换 Token', 'success');
    await loadApps(true);
    await renderPodcastShows();
  }

  async function openShowRuns(show) {
    const data = await podcast(`/shows/${encodeURIComponent(show.show_id)}/runs`);
    const runs = data.runs || [];
    showModal({
      title: `采集记录 · ${show.title}`,
      wide: true,
      body: runs.length ? table(['时间', '状态', '区间', '新增', '错误'], runs.map((run) => [
        fmtDateTime(run.started_at), badge(run.status),
        `${run.since || '—'} → ${run.until || '—'}`,
        `${run.inserted_count} / 更新 ${run.updated_count}`,
        run.error ? el('span', { title: run.error }, '有错误') : '—',
      ])) : emptyState('还没有采集记录'),
    });
  }

  function openShowSchedule(show) {
    const cron = el('input', { class: 'input', value: '0 9 * * *' });
    const timezone = el('input', { class: 'input', value: 'Asia/Shanghai' });
    const since = el('input', { class: 'input', type: 'date', value: defaultSince() });
    const until = el('input', { class: 'input', type: 'date', value: today() });
    const close = showModal({
      title: `定时同步 · ${show.title}`,
      subtitle: '每个节目一个 schedule；完成后在调度页查看',
      body: [
        el('div', { class: 'form-grid' },
          el('label', { class: 'field' }, el('span', {}, 'cron'), cron),
          el('label', { class: 'field' }, el('span', {}, '时区'), timezone),
          el('label', { class: 'field' }, el('span', {}, '开始日期'), since),
          el('label', { class: 'field' }, el('span', {}, '结束日期'), until)),
        el('div', { class: 'hint' }, '例如每天 09:00：0 9 * * *；每周一 09:00：0 9 * * 1。'),
      ],
      actions: [
        { label: '取消', onClick: close },
        {
          label: '创建调度', class: 'btn-primary',
          onClick: async () => {
            const result = await podcast(`/shows/${encodeURIComponent(show.show_id)}/schedule`, {
              method: 'POST',
              body: { cron: cron.value.trim(), timezone: timezone.value.trim(), since: since.value, until: until.value },
            });
            toast(`调度已创建 ${shortId(result.schedule?.schedule_id)}`, 'success');
            close();
            navigate('schedules');
          },
        },
      ],
    });
  }

  // ---------- 播客任务页 ----------

  async function renderPodcastTasks() {
    await loadApps();
    setPageActions(
      actionButton('刷新', 'refresh', () => renderPodcastTasks()),
      actionButton('新建采集', 'plus', () => openCollectModal(), 'btn btn-primary'));
    const [overview, data] = await Promise.all([
      loadPodcastOverview(),
      platform('/tasks?app_id=podcast-tools&limit=50'),
    ]);
    const tasks = data.tasks || [];
    clear(content);
    if (!overview.app_registered) {
      content.append(el('div', { class: 'notice notice-warn' },
        el('span', {}, '播客应用尚未注册，任务无法提交。'),
        actionButton('注册播客应用', 'plus', registerPodcastApp, 'btn btn-sm btn-primary')));
    }
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '播客任务'), el('div', { class: 'card-sub' }, '采集列表与单节目同步')),
        el('div', { class: 'toolbar' }, actionButton('新建采集', 'plus', () => openCollectModal(), 'btn btn-sm btn-primary'))),
      el('div', { class: 'card-body flush' }, tasksTable(tasks))));
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('div', {}, el('div', { class: 'card-title' }, '说明'), el('div', { class: 'card-sub' }, '任务数据流'))),
      el('div', { class: 'card-body' },
        el('p', { class: 'hint' }, '任务完成后可点击行查看事件、日志、输出；播客任务只写 podcast_ 前缀表，不碰平台表。'))));
  }

  // ---------- 日期 ----------

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function defaultSince() {
    const date = new Date();
    date.setUTCFullYear(date.getUTCFullYear() - 2);
    return date.toISOString().slice(0, 10);
  }

  // ---------- 启动 ----------

  async function start() {
    $('#login-form').addEventListener('submit', login);
    $('#logout-button').addEventListener('click', logout);
    for (const button of document.querySelectorAll('#nav button[data-route]')) {
      button.addEventListener('click', () => navigate(button.dataset.route));
    }
    window.addEventListener('hashchange', () => { if (state.me) renderCurrent(); });
    try {
      const me = await api('/api/me');
      state.me = me;
      showApp();
      await loadApps(true);
      if (!location.hash || (!routes[location.hash.replace(/^#\/?/, '')] && !transcriptEpisodeId())) {
        history.replaceState(null, '', '#/overview');
      }
      await renderCurrent();
    } catch {
      showLogin();
    }
  }

  start();
})();
