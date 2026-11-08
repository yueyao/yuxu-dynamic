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
    selectedCandidateIds: new Set(),
    showArchivedCandidates: false,
    transcriptFilters: { q: '', limit: 20 },
    transcribeTab: 'queue',
    queueSelected: new Set(),
    queueFilters: { q: '', showId: '', status: '', page: 1 },
    queueTimer: null,
    podcastTaskFilters: { status: '', type: '' },
    podcastTaskTimer: null,
  };

  const routes = {
    overview: { title: '总览', subtitle: '平台与播客任务运行概况', render: renderOverview },
    tasks: { title: '任务', subtitle: '提交、执行、关闭与重试', render: renderTasks },
    apps: { title: '应用', subtitle: '任务定义与 Worker 凭据', render: renderApps },
    schedules: { title: '调度', subtitle: 'cron 调度、下次触发与运行历史', render: renderSchedules },
    'podcast-shows': { title: '节目库', subtitle: '已采集节目、单集与一年范围更新', render: renderPodcastShows },
    'podcast-candidates': { title: '候选节目', subtitle: '尚未首次采集的备选节目', render: renderPodcastCandidates },
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
        el('button', { class: 'modal-close', type: 'button', onClick: () => close(), 'aria-label': '关闭' }, icon('x'))),
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
    const saved = localStorage.getItem('yuxun.username');
    if (saved) $('#login-username').value = saved;
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
      localStorage.setItem('yuxun.username', username);
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
    if (state.queueTimer) { clearTimeout(state.queueTimer); state.queueTimer = null; }
    if (state.podcastTaskTimer) { clearTimeout(state.podcastTaskTimer); state.podcastTaskTimer = null; }
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
            task.input?.title || task.task_key,
            task.source === 'schedule' ? el('span', { class: 'pill source' }, '调度') : null),
          el('div', { class: 'sub' }, `${task.task_key} · `, el('span', { class: 'id-chip' }, shortId(task.task_id)))),
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

  function podcastTasksTable(tasks, showTitles) {
    if (!tasks.length) return emptyState('暂无采集任务', '点击「新建采集」或到节目库同步节目。', 'layers');
    const rows = tasks.map((task) => {
      const input = task.input && typeof task.input === 'object' ? task.input : {};
      const output = task.output && typeof task.output === 'object' ? task.output : {};
      const isCollect = task.task_key === 'shows/collect';
      const type = isCollect ? '批量采集' : task.task_key === 'show/sync' ? '单节目同步' : task.task_key;

      let program = '—';
      if (isCollect) {
        const ids = Array.isArray(input.show_ids) ? input.show_ids : [];
        if (ids.length === 0) program = '全部节目';
        else {
          const names = ids.map((id) => showTitles.get(id) || shortId(id));
          program = names.length > 2 ? `${names[0]}、${names[1]} 等 ${names.length} 个` : names.join('、');
        }
      } else if (input.show_id) {
        program = showTitles.get(input.show_id) || shortId(input.show_id);
      }

      const range = input.since || input.until
        ? `${input.since || '—'} → ${input.until || '—'}`
        : '默认窗口';
      const inserted = Number(output.inserted);
      const updated = Number(output.updated);
      const failed = Number(output.failed);
      const hasResult = Number.isFinite(inserted) || Number.isFinite(updated);
      const created = Date.parse(task.created_at);
      const updatedAt = Date.parse(task.updated_at);
      const duration = Number.isFinite(created) && Number.isFinite(updatedAt) && updatedAt > created
        ? `${Math.max(1, Math.round((updatedAt - created) / 1000))} 秒` : null;

      const tr = el('tr', { class: 'clickable' }, [
        el('td', { class: 'nowrap', title: fmtDateTime(task.created_at) },
          el('div', {}, fmtDate(task.created_at)),
          duration ? el('div', { class: 'sub' }, duration) : null),
        el('td', {},
          el('div', { class: 'title-cell' }, type),
          el('div', { class: 'sub' }, task.source === 'schedule' ? '调度触发' : '手动触发')),
        el('td', {},
          el('div', { class: 'title-cell' }, program),
          el('div', { class: 'sub' }, isCollect
            ? (Array.isArray(input.show_ids) && input.show_ids.length ? `${input.show_ids.length} 个节目` : '全部节目')
            : shortId(task.task_id))),
        el('td', { class: 'nowrap' }, range),
        el('td', {},
          badge(task.status),
          task.status === 'running' || task.status === 'queued'
            ? progressCell(task.progress, task.status) : null,
          task.error ? el('div', { class: 'sub', style: 'color:var(--red)', title: task.error }, '有错误') : null),
        el('td', {},
          el('div', { class: 'title-cell' }, hasResult ? `新增 ${inserted || 0} / 更新 ${updated || 0}` : '—'),
          failed > 0 ? el('div', { class: 'sub', style: 'color:var(--red)' }, `失败 ${failed}`) : null),
        el('td', {}, actionButton('查看', 'arrow', (event) => {
          event.stopPropagation();
          openTask(task.task_id);
        }, 'btn btn-sm')),
      ]);
      tr.addEventListener('click', () => openTask(task.task_id));
      return tr;
    });
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['时间', '类型', '节目 / 范围', '采集区间', '状态', '新增 / 更新', '操作']
        .map((header) => el('th', {}, header)))),
      el('tbody', {}, rows)));
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
                await renderCurrent();
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
    const [tasksData, schedulesData, podcastData, showsData, queueData] = await Promise.all([
      platform('/tasks?limit=20'),
      platform('/schedules'),
      podcast('/overview').catch(() => null),
      podcast('/shows').catch(() => null),
      transcription('/queue').catch(() => null),
    ]);
    const tasks = tasksData.tasks || [];
    const schedules = schedulesData.schedules || [];
    const shows = showsData ? showsData.shows || [] : [];
    const running = tasks.filter((task) => task.status === 'running').length;
    const queued = tasks.filter((task) => task.status === 'queued').length;
    const queueCounts = queueData ? queueData.counts || {} : {};
    const queueRunning = queueCounts.running || 0;
    const queuePending = queueCounts.pending || 0;
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
        el('p', {}, `今天有 ${running + queueRunning} 个任务执行中、${queued + queuePending} 个排队；播客库已收录 ${podcastData ? podcastData.shows : shows.length} 个节目、${podcastData ? podcastData.episodes : 0} 条单集。`),
        el('div', { class: 'hero-actions' },
          actionButton('打开节目库', 'mic', () => navigate('podcast-shows'), 'btn btn-primary'),
          actionButton('转写队列', 'layers', () => navigate('transcribe-queue'), 'btn btn-on-dark'),
          actionButton('新建采集', 'plus', () => openCollectModal(), 'btn btn-on-dark'))),
      el('div', { class: 'hero-panel' },
        el('div', { class: 'hero-panel-head' }, el('span', {}, 'SYSTEM PULSE'), el('span', { class: 'dot green' })),
        el('div', { class: 'hero-row' }, el('span', {}, '已启用调度'), el('strong', {}, `${enabledSchedules.length} 个`)),
        el('div', { class: 'hero-row' }, el('span', {}, '最近触发'), el('strong', {}, upcoming[0] ? fmtRelative(upcoming[0].next_fire_at) : '—')),
        el('div', { class: 'hero-row' }, el('span', {}, '转写队列'), el('strong', {}, `待转写 ${queuePending} · 运行 ${queueRunning}`)),
        el('div', { class: 'hero-row' }, el('span', {}, '覆盖状态'), el('strong', {}, `${partial} 个 partial`)),
        el('div', { class: 'hero-row' }, el('span', {}, '存储'), el('strong', {}, 'SQLite WAL')))));

    if (podcastData && !podcastData.app_registered) {
      content.append(el('div', { class: 'notice notice-warn' },
        el('div', {}, el('strong', {}, '播客应用尚未注册'), el('div', { class: 'hint' }, '注册播客应用并启动 Podcast Worker 后，采集任务才会执行。')),
        actionButton('去注册', 'plus', () => navigate('apps'), 'btn btn-sm btn-primary')));
    }

    content.append(el('div', { class: 'stats-grid' },
      statCard('执行中', running + queueRunning, '平台任务 + 转写队列', 'activity', 'amber'),
      statCard('排队', queued + queuePending, '平台任务 + 转写队列', 'clock', 'blue'),
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
        { label: '取消', onClick: () => close() },
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
          actionButton('立即运行', 'play', () => runSchedule(schedule.schedule_id), 'btn btn-sm'),
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
        { label: '取消', onClick: () => close() },
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
    return renderShowLibrary('active');
  }

  async function renderPodcastCandidates() {
    return renderShowLibrary('candidate');
  }

  async function renderShowLibrary(mode) {
    const active = mode === 'active';
    const selection = active ? state.selectedShowIds : state.selectedCandidateIds;
    const rerender = () => renderShowLibrary(mode);
    const [overview, showsData, runsData] = await Promise.all([
      loadPodcastOverview(),
      podcast('/shows'),
      active ? podcast('/runs').catch(() => ({ runs: [] })) : Promise.resolve({ runs: [] }),
    ]);
    const allShows = showsData.shows || [];
    const candidates = allShows.filter((show) => !show.last_sync_at && !show.archived_at);
    const archivedCandidates = allShows.filter((show) => !show.last_sync_at && Boolean(show.archived_at));
    const activeShows = allShows.filter((show) => Boolean(show.last_sync_at));
    const shows = active
      ? activeShows
      : (state.showArchivedCandidates ? [...candidates, ...archivedCandidates] : candidates);
    const runs = runsData.runs || [];

    const actions = [actionButton('刷新', 'refresh', rerender)];
    if (active) {
      if (shows.length) {
        actions.push(actionButton('采集一年', 'layers',
          () => openCollectModal(new Set(shows.map((show) => show.show_id))), 'btn'));
      }
    } else if (candidates.length) {
      actions.push(actionButton('采集全部候选', 'layers',
        () => openCollectModal(new Set(candidates.map((show) => show.show_id))), 'btn'));
    }
    if (!active && archivedCandidates.length) {
      actions.push(actionButton(
        state.showArchivedCandidates ? '隐藏已忽略' : `显示已忽略（${archivedCandidates.length}）`,
        'database',
        () => { state.showArchivedCandidates = !state.showArchivedCandidates; rerender(); },
        'btn'));
    }
    actions.push(actionButton('添加节目', 'plus', openAddShow, 'btn btn-primary'));
    setPageActions(...actions);

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

    if (active) {
      content.append(el('div', { class: 'stats-grid' },
        statCard('节目', shows.length, `${overview.partial_shows} 个不完整`, 'mic', 'green'),
        statCard('单集', overview.episodes, '列表元数据', 'layers', 'blue'),
        statCard('播客应用', overview.app_registered ? '已注册' : '未注册', overview.app_id, 'app', 'purple'),
        statCard('最近采集', overview.last_run_at ? fmtRelative(overview.last_run_at) : '—', '仅列表，无音频', 'clock', 'amber')));
    } else {
      content.append(el('div', { class: 'stats-grid' },
        statCard('候选节目', candidates.length, '尚未首次采集', 'database', 'blue'),
        statCard('已忽略', archivedCandidates.length, '不参与批量采集', 'x', 'amber'),
        statCard('已入库节目', activeShows.length, '至少采集过一次', 'mic', 'green'),
        statCard('最近采集', overview.last_run_at ? fmtRelative(overview.last_run_at) : '—', '首次采集后转入节目库', 'clock', 'amber')));
      content.append(el('div', { class: 'notice' },
        el('div', {},
          el('strong', {}, '候选节目'),
          el('div', { class: 'hint' }, '这里是从榜单导入、但还没有拉取过任何基础数据的节目。做过一次采集后会自动进入「节目库」，之后持续更新。'))));
    }

    const search = el('input', { class: 'input', placeholder: '搜索节目、作者或链接' });
    const bulkLabel = el('span', {}, active ? '批量采集' : '批量采集候选');
    const bulkButton = el('button', {
      class: 'btn btn-sm', type: 'button', disabled: selection.size === 0,
      onClick: () => openCollectModal(selection),
    }, icon('layers'), bulkLabel);
    const updateBulk = () => {
      const count = selection.size;
      bulkLabel.textContent = count ? `批量采集（${count}）` : (active ? '批量采集' : '批量采集候选');
      bulkButton.disabled = count === 0;
    };
    updateBulk();

    let trs = [];
    const selectAll = el('input', {
      type: 'checkbox', 'aria-label': '全选当前显示',
      onChange: (event) => {
        for (const tr of trs) {
          if (tr.hidden) continue;
          const box = tr.querySelector('input[type=checkbox]');
          if (!box || box.disabled) continue;
          box.checked = event.target.checked;
          if (event.target.checked) selection.add(box.dataset.showId);
          else selection.delete(box.dataset.showId);
        }
        updateBulk();
      },
    });

    const rows = shows.map((show) => [
      el('input', {
        type: 'checkbox', checked: selection.has(show.show_id), dataset: { showId: show.show_id },
        disabled: !active && Boolean(show.archived_at),
        'aria-label': `选择 ${show.title}`,
        onChange: (event) => {
          if (event.target.checked) selection.add(show.show_id);
          else selection.delete(show.show_id);
          updateBulk();
        },
      }),
      el('div', { class: 'show-cell' },
        showCover(show),
        el('div', { style: 'min-width:0' },
          el('div', { class: 'show-title' }, show.title,
            !active && show.archived_at ? el('span', { class: 'pill' }, '已忽略') : null),
          el('div', { class: 'show-author' }, show.author || '未知作者'),
          el('div', { class: 'sub' },
            show.rss_url ? el('span', { class: 'pill source' }, 'RSS') : el('span', { class: 'pill' }, '公开页'),
            el('a', { class: 'show-link', href: show.url, target: '_blank', rel: 'noopener', title: show.url }, show.url)))),
      el('div', {},
        el('div', { class: 'title-cell' }, show.episode_count > 0 ? `已入库 ${show.episode_count} 集` : '尚未采集'),
        el('div', { class: 'sub' }, show.rss_url
          ? `RSS 共 ${show.total_episode_count ?? show.page_episode_count ?? '—'} 集`
          : (show.page_episode_count || show.total_episode_count
            ? `页面 ${show.page_episode_count ?? '—'} / 总计 ${show.total_episode_count ?? '—'}` : '等待首次采集'))),
      el('div', {}, coverageBar(show),
        badge(show.coverage_status === 'full' ? 'full' : show.coverage_status === 'unknown' ? 'unknown' : 'partial')),
      el('div', {},
        el('div', {}, show.last_sync_at ? fmtDateTime(show.last_sync_at) : '—'),
        el('div', { class: 'sub' }, show.last_sync_status
          ? (STATUS_LABELS[show.last_sync_status] || show.last_sync_status)
          : (active ? '未同步' : '尚未首次采集')),
        show.last_error ? el('div', { class: 'sub', title: show.last_error, style: 'color:var(--red)' }, '最近一次有错误') : null),
      el('div', { class: 'row-actions' },
        !active && show.archived_at
          ? iconAction('恢复', 'refresh', () => setArchivedShow(show, false))
          : iconAction(active ? '同步' : '首次采集', 'refresh', () => syncShow(show.show_id)),
        iconAction('查看单集', 'layers', () => openEpisodes(show)),
        active ? iconAction('定时同步', 'calendar', () => openShowSchedule(show)) : null,
        active ? iconAction('采集记录', 'clock', () => openShowRuns(show)) : null,
        !active && !show.archived_at
          ? iconAction('忽略', 'x', () => setArchivedShow(show, true))
          : null),
    ]);

    const tableNode = shows.length
      ? table([selectAll, '节目', '单集', '覆盖', '最近同步', '操作'], rows)
      : emptyState(
        active ? '还没有已采集节目' : '没有候选节目',
        active ? '去候选节目里做首次采集，或直接添加节目。'
          : (archivedCandidates.length ? '当前没有活跃候选；可以显示已忽略的节目并恢复。' : '所有节目都至少采集过一次了。'),
        active ? 'mic' : 'database');

    if (shows.length) {
      trs = [...tableNode.querySelectorAll('tbody tr')];
      trs.forEach((tr, index) => {
        tr.dataset.search = `${shows[index].title} ${shows[index].author || ''} ${shows[index].url}`.toLowerCase();
      });
      search.addEventListener('input', () => {
        const keyword = search.value.trim().toLowerCase();
        for (const tr of trs) tr.hidden = keyword.length > 0 && !tr.dataset.search.includes(keyword);
      });
    }

    const selectedCount = selection.size;
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {},
          el('div', { class: 'card-title' }, active ? '节目库' : '候选节目'),
          el('div', { class: 'card-sub' }, selectedCount
            ? `已选 ${selectedCount} 个节目，可在采集弹窗中批量提交`
            : (active ? '已采集过的节目会持续更新' : '首次采集成功后自动进入节目库'))),
        el('div', { class: 'toolbar' }, bulkButton, search)),
      el('div', { class: 'card-body flush' }, tableNode)));

    if (active) {
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
  }

  async function setArchivedShow(show, archived) {
    const verb = archived ? '忽略' : '恢复';
    if (!window.confirm(`${verb}节目「${show.title}」？`)) return;
    try {
      await podcast(`/shows/${encodeURIComponent(show.show_id)}/archive`, {
        method: 'POST', body: { archived },
      });
      if (archived) state.selectedCandidateIds.delete(show.show_id);
      toast(`已${verb}「${show.title}」`, 'success');
      await renderShowLibrary('candidate');
    } catch (error) {
      toast(error.message, 'error');
    }
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
    if (action === 'clear' && !window.confirm('清空队列里已完成、失败的项目？历史转写稿不会删除。')) return;
    try {
      await transcription(`/queue/${action}`, { method: 'POST' });
      toast(successMessage, 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
    await renderTranscribeQueue();
  }

  async function queueItem(id, action, body) {
    if (action === 'delete' && !window.confirm('从转写队列移除这一集？')) return;
    try {
      if (action === 'toggle') {
        await transcription(`/queue/${encodeURIComponent(id)}`, { method: 'PATCH', body });
        toast('已更新启用状态', 'success');
        await renderTranscribeQueue();
        return;
      }
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

  async function queueBulk(action, ids) {
    if (!ids.length) return;
    const labels = {
      enable: '启用', disable: '停用', remove: '移除', cancel: '取消转写', retry: '重试',
    };
    if (action === 'cancel' && !window.confirm(`取消选中的 ${ids.length} 项？运行中的任务会被关闭。`)) return;
    if (action === 'remove' && !window.confirm(`从队列移除选中的 ${ids.length} 项？`)) return;
    try {
      const result = await transcription('/queue/bulk', { method: 'POST', body: { action, ids } });
      const extra = result.skipped ? `，跳过 ${result.skipped} 项` : '';
      toast(`${labels[action]}完成 ${result.updated} 项${extra}`, result.errors?.length ? 'error' : 'success');
      state.queueSelected.clear();
      await renderTranscribeQueue();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function renderTranscribeQueue() {
    if (state.queueTimer) { clearTimeout(state.queueTimer); state.queueTimer = null; }
    setPageActions(actionButton('刷新', 'refresh', () => renderTranscribeQueue()));
    const filters = state.transcriptFilters;
    const params = new URLSearchParams({ limit: String(filters.limit) });
    if (filters.q) params.set('q', filters.q);
    const [data, transcriptData] = await Promise.all([
      transcription('/queue'),
      transcription(`/transcripts?${params}`).catch(() => ({ transcripts: [] })),
    ]);
    const items = data.items || [];
    const queueItems = items.filter((item) => !['done', 'canceled'].includes(item.status));
    const counts = data.counts || {};
    const transcripts = transcriptData.transcripts || [];
    const transcriptTotal = transcriptData.total ?? transcripts.length;
    const validIds = new Set(queueItems.map((item) => item.id));
    for (const id of [...state.queueSelected]) if (!validIds.has(id)) state.queueSelected.delete(id);

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

    const tabs = el('div', { class: 'tabs' },
      el('button', {
        type: 'button', class: `tab ${state.transcribeTab === 'queue' ? 'active' : ''}`,
        onClick: () => { state.transcribeTab = 'queue'; renderTranscribeQueue(); },
      }, `转写队列 ${queueItems.length}`),
      el('button', {
        type: 'button', class: `tab ${state.transcribeTab === 'history' ? 'active' : ''}`,
        onClick: () => { state.transcribeTab = 'history'; renderTranscribeQueue(); },
      }, `已入库转写稿 ${transcriptTotal}`));
    content.append(tabs);

    if (state.transcribeTab === 'history') {
      renderTranscriptHistory(transcripts, transcriptTotal);
      return;
    }

    const queueFilters = state.queueFilters;
    const keyword = queueFilters.q.trim().toLowerCase();
    const filteredQueue = queueItems.filter((item) => {
      if (queueFilters.showId && item.show_id !== queueFilters.showId) return false;
      if (queueFilters.status && item.status !== queueFilters.status) return false;
      if (keyword && !`${item.title} ${item.show_title || ''} ${item.id}`.toLowerCase().includes(keyword)) return false;
      return true;
    });
    const hasQueueFilter = Boolean(queueFilters.q || queueFilters.showId || queueFilters.status);
    const pageSize = 20;
    const totalPages = Math.max(1, Math.ceil(filteredQueue.length / pageSize));
    const page = Math.min(Math.max(1, queueFilters.page), totalPages);
    queueFilters.page = page;
    const pageItems = filteredQueue.slice((page - 1) * pageSize, page * pageSize);

    const showMap = new Map();
    for (const item of queueItems) {
      if (item.show_id && !showMap.has(item.show_id)) {
        showMap.set(item.show_id, item.show_title || shortId(item.show_id));
      }
    }

    const resetFilters = () => {
      state.queueFilters = { q: '', showId: '', status: '', page: 1 };
      state.queueSelected.clear();
      renderTranscribeQueue();
    };
    const showSelect = el('select', {
      class: 'select',
      onChange: (event) => {
        state.queueFilters.showId = event.target.value;
        state.queueFilters.page = 1;
        state.queueSelected.clear();
        renderTranscribeQueue();
      },
    }, option('', '全部播客', !queueFilters.showId),
      [...showMap.entries()].map(([id, title]) => option(id, title, queueFilters.showId === id)));
    const statusSelect = el('select', {
      class: 'select',
      onChange: (event) => {
        state.queueFilters.status = event.target.value;
        state.queueFilters.page = 1;
        state.queueSelected.clear();
        renderTranscribeQueue();
      },
    }, option('', '全部状态', !queueFilters.status),
      option('pending', '待转写', queueFilters.status === 'pending'),
      option('running', '运行中', queueFilters.status === 'running'),
      option('failed', '失败', queueFilters.status === 'failed'));
    const queueSearch = el('input', {
      class: 'input', value: queueFilters.q, placeholder: '搜索播客或单集',
      onKeydown: (event) => {
        if (event.key === 'Enter') {
          state.queueFilters.q = event.target.value.trim();
          state.queueFilters.page = 1;
          state.queueSelected.clear();
          renderTranscribeQueue();
        }
      },
    });
    const filterParts = [];
    if (queueFilters.showId) filterParts.push(showMap.get(queueFilters.showId) || '指定播客');
    if (queueFilters.status) {
      filterParts.push({ pending: '待转写', running: '运行中', failed: '失败' }[queueFilters.status] || queueFilters.status);
    }
    if (queueFilters.q) filterParts.push(`关键词「${queueFilters.q}」`);
    const filterBar = el('div', { class: 'queue-filter-bar' },
      queueSearch,
      showSelect,
      statusSelect,
      actionButton('查询', 'search', () => {
        state.queueFilters.q = queueSearch.value.trim();
        state.queueFilters.page = 1;
        state.queueSelected.clear();
        renderTranscribeQueue();
      }, 'btn btn-sm'),
      hasQueueFilter ? actionButton('重置筛选', 'x', resetFilters, 'btn btn-sm') : null,
      el('span', { class: 'queue-filter-summary' },
        hasQueueFilter ? `当前筛选：${filterParts.join(' · ')}` : '当前显示全部待处理项'));

    const queueStopped = data.paused || !data.runner;
    const cardHead = el('div', { class: 'card-head' },
      el('div', {},
        el('div', { class: 'card-title' }, '转写队列'),
        el('div', { class: 'card-sub' },
          `显示 ${filteredQueue.length}/${queueItems.length} 项，已完成 ${counts.done || 0} 项；Web 负责选择与顺序，Worker 只执行平台下发的任务`)),
      el('div', { class: 'row-actions' },
        queueStopped
          ? actionButton('开始队列', 'play', () => queueAction('start', '队列已启动'), 'btn btn-primary')
          : actionButton('暂停队列', 'x', () => queueAction('pause', '队列已暂停'), 'btn'),
        actionButton('清空已结束', 'x', () => queueAction('clear', '已清理结束项'), 'btn btn-sm'),
        actionButton('去节目库选单集', 'mic', () => navigate('podcast-shows'), 'btn btn-sm')));

    const selected = state.queueSelected;
    const selectedLabel = el('span', { class: 'queue-bulk-count' });
    const bulkBar = el('div', { class: 'queue-bulk-bar' },
      selectedLabel,
      actionButton('启用', 'check', () => queueBulk('enable', [...selected]), 'btn btn-sm'),
      actionButton('停用', 'x', () => queueBulk('disable', [...selected]), 'btn btn-sm'),
      actionButton('取消转写', 'x', () => queueBulk('cancel', [...selected]), 'btn btn-sm btn-danger'),
      actionButton('移除', 'x', () => queueBulk('remove', [...selected]), 'btn btn-sm'),
      actionButton('重试', 'refresh', () => queueBulk('retry', [...selected]), 'btn btn-sm'),
      actionButton('清除选择', 'x', () => { selected.clear(); renderTranscribeQueue(); }, 'btn btn-sm'));
    const syncBulk = () => {
      selectedLabel.textContent = `已选 ${selected.size} 项`;
      bulkBar.hidden = selected.size === 0;
    };

    let selectAll;
    selectAll = el('input', {
      type: 'checkbox', 'aria-label': '全选筛选结果',
      onChange: (event) => {
        selected.clear();
        if (event.target.checked) for (const item of filteredQueue) selected.add(item.id);
        syncBulk();
        for (const box of document.querySelectorAll('.queue-select-box')) box.checked = event.target.checked;
      },
    });

    const rows = pageItems.map((item, index) => {
      const checked = selected.has(item.id);
      const box = el('input', {
        type: 'checkbox', class: 'queue-select-box', checked,
        'aria-label': `选择 ${item.title}`,
        onChange: (event) => {
          if (event.target.checked) selected.add(item.id);
          else selected.delete(item.id);
          syncBulk();
        },
      });
      const canMove = !hasQueueFilter && item.status !== 'running';
      return [
        el('td', {}, box),
        el('td', { class: 'nowrap' }, (page - 1) * pageSize + index + 1),
        el('td', {},
          el('div', { class: 'title-cell' }, item.show_title || '—'),
          el('div', { class: 'sub' }, shortId(item.show_id))),
        el('td', {},
          el('div', { class: 'title-cell' }, item.title),
          item.enabled ? null : el('div', { class: 'sub' }, '已停用')),
        el('td', {},
          queueBadge(item.status),
          item.status === 'running' ? progressCell(item.progress, 'running') : null,
          item.error ? el('div', { class: 'sub', style: 'color:var(--red)', title: item.error },
            String(item.error).slice(0, 80)) : null),
        el('td', {},
          el('div', { class: 'mono' }, item.task_id ? shortId(item.task_id) : '—')),
        el('td', {}, el('div', { class: 'row-actions' },
          canMove ? actionButton('置顶', 'arrow', () => queueItem(item.id, 'move', { direction: 'top' }), 'btn btn-sm') : null,
          canMove ? actionButton('上移', 'arrow', () => queueItem(item.id, 'move', { direction: 'up' }), 'btn btn-sm') : null,
          canMove ? actionButton('下移', 'arrow', () => queueItem(item.id, 'move', { direction: 'down' }), 'btn btn-sm') : null,
          item.status === 'running'
            ? actionButton('取消', 'x', () => queueBulk('cancel', [item.id]), 'btn btn-sm btn-danger')
            : actionButton(item.enabled ? '停用' : '启用', item.enabled ? 'x' : 'check',
              () => queueItem(item.id, 'toggle', { enabled: !item.enabled }), 'btn btn-sm'),
          item.status === 'failed'
            ? actionButton('重试', 'refresh', () => queueItem(item.id, 'retry', null), 'btn btn-sm')
            : null,
          item.status !== 'running'
            ? actionButton('移除', 'x', () => queueItem(item.id, 'delete', null), 'btn btn-sm')
            : null)),
      ];
    });

    const tableNode = pageItems.length
      ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, [selectAll, '#', '播客', '单集', '状态', '任务', '操作'].map((header) => el('th', {}, header)))),
        el('tbody', {}, rows.map((cells) => el('tr', {}, cells)))))
      : emptyState(hasQueueFilter ? '没有匹配的队列项' : '队列为空',
        hasQueueFilter ? '调整播客、状态或关键词后重试。' : '去节目库打开单集，勾选后加入转写队列。', 'mic');

    const pager = el('div', { class: 'queue-pagination' },
      el('button', {
        class: 'btn btn-sm', type: 'button', disabled: page <= 1,
        onClick: () => { state.queueFilters.page = page - 1; renderTranscribeQueue(); },
      }, '上一页'),
      el('span', { class: 'hint' }, `第 ${page} / ${totalPages} 页 · 共 ${filteredQueue.length} 项`),
      el('button', {
        class: 'btn btn-sm', type: 'button', disabled: page >= totalPages,
        onClick: () => { state.queueFilters.page = page + 1; renderTranscribeQueue(); },
      }, '下一页'));

    content.append(el('section', { class: 'card' },
      cardHead,
      el('div', { class: 'card-body flush' }, filterBar, bulkBar, tableNode, pager)));
    syncBulk();

    if ((counts.running || 0) > 0 || (data.runner && (counts.pending || 0) > 0)) {
      state.queueTimer = setTimeout(() => {
        if (state.route !== 'transcribe-queue') return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
          state.queueTimer = setTimeout(() => renderTranscribeQueue(), 5000);
          return;
        }
        renderTranscribeQueue();
      }, 5000);
    }
  }

  function renderTranscriptHistory(transcripts, transcriptTotal) {
    const filters = state.transcriptFilters;
    const queryInput = el('input', {
      class: 'input', value: filters.q, placeholder: '搜索单集标题或 episode id',
      onKeydown: (event) => {
        if (event.key === 'Enter') {
          state.transcriptFilters.q = event.target.value.trim();
          renderTranscribeQueue();
        }
      },
    });
    const limitSelect = el('select', {
      class: 'select',
      onChange: (event) => {
        state.transcriptFilters.limit = Number(event.target.value);
        renderTranscribeQueue();
      },
    }, [20, 50, 100].map((value) => option(String(value), `最近 ${value} 条`, filters.limit === value)));
    const rows = transcripts.map((transcript) => [
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
          ? actionButton('查看', 'tasks',
            () => navigate(`transcript/${encodeURIComponent(transcript.episode_id)}`), 'btn btn-sm')
          : null,
        transcript.transcript_id
          ? actionButton('下载 MD', 'download', () => {
            window.location.href = `/api/transcription/transcripts/${encodeURIComponent(transcript.transcript_id)}/markdown`;
          }, 'btn btn-sm')
          : null),
    ]);
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '已入库转写稿'),
          el('div', { class: 'card-sub' }, `显示 ${transcripts.length} / ${transcriptTotal} 条；支持标题与 episode id 搜索`)),
        el('div', { class: 'toolbar' }, queryInput,
          actionButton('查询', 'search', () => {
            state.transcriptFilters.q = queryInput.value.trim();
            renderTranscribeQueue();
          }, 'btn btn-sm btn-primary'),
          limitSelect,
          filters.q ? actionButton('清空', 'x', () => {
            state.transcriptFilters.q = '';
            renderTranscribeQueue();
          }, 'btn btn-sm') : null)),
      el('div', { class: 'card-body flush' },
        transcripts.length
          ? table(['单集', '节目', '时长', '片段', '引擎', '完成时间', '操作'], rows)
          : emptyState('没有匹配的转写稿', filters.q ? '换个关键词，或清空搜索条件。' : '队列完成一集后会自动写入这里。', 'tasks'))));
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
        { label: '取消', onClick: () => close() },
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
          el('span', {}, '公开页只有最近 15 集；没有 RSS 的节目会标记为 partial，不会伪造一年完整数据。')),
        el('div', { class: 'hint' }, '任务只抓列表元数据，不下载音频；完成后到“采集任务”查看状态。'),
      ],
      actions: [
        { label: '取消', onClick: () => close() },
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
    const data = await podcast(`/shows/${encodeURIComponent(show.show_id)}/episodes?limit=500`);
    const episodes = data.episodes || [];
    const selected = new Set();
    const rowMeta = [];
    const currentYear = new Date().getFullYear();
    let visibleCount = episodes.length;

    const counter = el('span', { class: 'hint' }, '');
    const addButton = actionButton('加入转写队列', 'plus', async () => {
      if (selected.size === 0) return;
      try {
        const result = await transcription('/queue', {
          method: 'POST', body: { episode_ids: [...selected] },
        });
        const existing = result.skipped_existing || 0;
        const parts = [`已加入 ${result.added} 集`];
        if (result.skipped) parts.push(`已在队列 ${result.skipped} 集`);
        if (existing) parts.push(`已有转写稿 ${existing} 集`);
        toast(result.added === 0 && existing ? '所选单集都已有转写稿，已跳过' : parts.join('，'), 'success');
        closeModal();
        if (state.route === 'transcribe-queue') await renderTranscribeQueue();
      } catch (error) {
        toast(error.message, 'error');
      }
    }, 'btn btn-sm btn-primary');
    addButton.disabled = true;

    const syncSelection = () => {
      addButton.disabled = selected.size === 0;
      counter.textContent = `显示 ${visibleCount} / ${episodes.length} 集，已选 ${selected.size} 集`;
    };

    const yearToggle = el('input', {
      type: 'checkbox', 'aria-label': '只看今年',
      onChange: () => { applyYearFilter(); },
    });

    const selectAll = el('input', {
      type: 'checkbox', 'aria-label': '全选当前显示',
      onChange: (event) => {
        selected.clear();
        for (let index = 0; index < rowMeta.length; index += 1) {
          const meta = rowMeta[index];
          if (meta.row.hidden) {
            meta.checkbox.checked = false;
            continue;
          }
          meta.checkbox.checked = event.target.checked;
          if (event.target.checked) selected.add(meta.episode.episode_id);
        }
        syncSelection();
      },
    });

    let applyYearFilter = () => {};

    const toolbar = el('div', { class: 'toolbar' },
      el('label', { class: 'checkbox-row' }, selectAll, el('span', {}, '全选当前显示')),
      el('label', { class: 'checkbox-row' }, yearToggle, el('span', {}, `只看 ${currentYear} 年`)),
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
      const row = el('tr', {}, [
        el('td', {}, checkbox),
        el('td', {},
          el('div', { class: 'title-cell' }, episode.title),
          episode.description ? el('div', { class: 'sub' }, String(episode.description).slice(0, 110)) : null),
        el('td', {}, fmtDateTime(episode.published_at)),
        el('td', {}, fmtDuration(episode.duration_seconds)),
        el('td', {}, episode.source),
        el('td', {}, el('div', { class: 'row-actions' },
          actionButton('转写', 'mic', () => transcribeEpisode(episode), 'btn btn-sm'),
          actionButton('转写稿', 'tasks', () => openTranscript(episode), 'btn btn-sm'))),
      ]);
      rowMeta.push({ row, checkbox, episode });
      return row;
    });

    const tableNode = episodes.length
      ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['', '标题', '发布时间', '时长', '来源', '操作'].map((header) => el('th', {}, header)))),
        el('tbody', {}, rows)))
      : emptyState('还没有单集', '点击同步后按日期范围入库。', 'mic');

    applyYearFilter = () => {
      visibleCount = 0;
      for (const meta of rowMeta) {
        const date = meta.episode.published_at ? new Date(meta.episode.published_at) : null;
        const showRow = !yearToggle.checked || (date && date.getFullYear() === currentYear);
        meta.row.hidden = !showRow;
        if (showRow) {
          visibleCount += 1;
        } else {
          meta.checkbox.checked = false;
          selected.delete(meta.episode.episode_id);
        }
      }
      selectAll.checked = false;
      syncSelection();
    };

    syncSelection();

    let closeModal = () => {};
    closeModal = showModal({
      title: `单集 · ${show.title}`,
      subtitle: `${episodes.length} 条已入库；可以只看今年并全选后加入转写队列`,
      wide: true,
      body: el('div', {}, toolbar, tableNode),
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
    if (result.added === 0) {
      toast(result.skipped_existing ? '该集已有转写稿，已跳过' : '该集已经在转写队列中', 'success');
      return;
    }
    await transcription('/queue/start', { method: 'POST' });
    toast('已加入转写队列并开始', 'success');
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
      actionButton('下载 Markdown', 'download', () => {
        if (!transcript.transcript_id) {
          toast('缺少转写稿 ID，无法下载', 'error');
          return;
        }
        window.location.href = `/api/transcription/transcripts/${encodeURIComponent(transcript.transcript_id)}/markdown`;
      }, 'btn btn-primary'),
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
        { label: '取消', onClick: () => close() },
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
    if (state.podcastTaskTimer) { clearTimeout(state.podcastTaskTimer); state.podcastTaskTimer = null; }
    await loadApps();
    setPageActions(
      actionButton('刷新', 'refresh', () => renderPodcastTasks()),
      actionButton('新建采集', 'plus', () => openCollectModal(), 'btn btn-primary'));
    const statusSelect = el('select', {
      class: 'select',
      onChange: (event) => {
        state.podcastTaskFilters.status = event.target.value;
        renderPodcastTasks();
      },
    }, option('', '全部状态', !state.podcastTaskFilters.status),
      ['queued', 'running', 'succeeded', 'failed', 'closed'].map((status) =>
        option(status, STATUS_LABELS[status], state.podcastTaskFilters.status === status)));
    const typeSelect = el('select', {
      class: 'select',
      onChange: (event) => {
        state.podcastTaskFilters.type = event.target.value;
        renderPodcastTasks();
      },
    }, option('', '全部类型', !state.podcastTaskFilters.type),
      option('collect', '批量采集', state.podcastTaskFilters.type === 'collect'),
      option('sync', '单节目同步', state.podcastTaskFilters.type === 'sync'));

    const params = new URLSearchParams({ app_id: 'podcast-tools', limit: '50' });
    if (state.podcastTaskFilters.status) params.set('status', state.podcastTaskFilters.status);
    const [overview, data, showsData] = await Promise.all([
      loadPodcastOverview(),
      platform(`/tasks?${params.toString()}`),
      podcast('/shows').catch(() => ({ shows: [] })),
    ]);
    const tasks = (data.tasks || []).filter((task) => {
      if (!state.podcastTaskFilters.type) return true;
      return state.podcastTaskFilters.type === 'collect'
        ? task.task_key === 'shows/collect' : task.task_key === 'show/sync';
    });
    const showTitles = new Map((showsData.shows || []).map((show) => [show.show_id, show.title]));
    clear(content);
    if (!overview.app_registered) {
      content.append(el('div', { class: 'notice notice-warn' },
        el('span', {}, '播客应用尚未注册，任务无法提交。'),
        actionButton('注册播客应用', 'plus', registerPodcastApp, 'btn btn-sm btn-primary')));
    }
    content.append(el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('div', {}, el('div', { class: 'card-title' }, '采集任务'),
          el('div', { class: 'card-sub' }, `${tasks.length} 个任务`)),
        el('div', { class: 'toolbar' }, statusSelect, typeSelect,
          actionButton('新建采集', 'plus', () => openCollectModal(), 'btn btn-sm btn-primary'))),
      el('div', { class: 'card-body flush' }, podcastTasksTable(tasks, showTitles))));

    if (tasks.some((task) => task.status === 'queued' || task.status === 'running')) {
      state.podcastTaskTimer = setTimeout(() => {
        if (state.route !== 'podcast-tasks') return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
          state.podcastTaskTimer = setTimeout(() => renderPodcastTasks(), 10000);
          return;
        }
        renderPodcastTasks();
      }, 10000);
    }
  }

  // ---------- 日期 ----------

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function defaultSince() {
    const date = new Date();
    date.setUTCFullYear(date.getUTCFullYear() - 1);
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
