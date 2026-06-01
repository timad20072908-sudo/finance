// Salary Allocation Planner — фронтенд (vanilla JS).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const api = {
  async req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) { showAuthGate(); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  get: (u) => api.req('GET', u),
  post: (u, b) => api.req('POST', u, b),
  put: (u, b) => api.req('PUT', u, b),
  del: (u) => api.req('DELETE', u),
};

// ---------- state ----------
const state = {
  meta: null,
  plan: null,
  items: [],
  allocation: null,
  scenarios: [],
  history: [],
  goals: [],
  view: 'dashboard',
  scenario: 'balanced',
  customInclude: [],
  queue: { q: '', layer: '', type: '', band: '', sortKey: 'priority', sortDir: 'desc', compact: false },
};

// ---------- helpers ----------
const fmt = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU') + ' грн';
const fmtShort = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU');
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2400);
}
function layerLabel(key) { const l = state.meta?.layers?.[key]; return l ? `${l.ru}` : key; }
function layerColor(key) { return state.meta?.layers?.[key]?.color || '#64748b'; }
// Совместимость со старыми вызовами.
const bucketLabel = layerLabel;
const bucketColor = layerColor;
function catObj(id) { return state.meta?.categories?.find((c) => c.id === id); }
function catLabel(id) { const c = catObj(id); return c ? `${c.ru} · ${c.label}` : id; }
function catLabelShort(id) { const c = catObj(id); return c ? c.ru : id; }
function bandLabel(id) { const b = state.meta?.bands?.find((x) => x.id === id); return b ? b.label : id; }
const TYPE_LABELS = { must: 'Must', should: 'Should', nice: 'Nice' };
const STATUS_LABELS = { safe: 'Безопасно', tight: 'Впритык', overallocated: 'Перерасход' };
const VERDICT_LABELS = { keep: 'Брать', reconsider: 'Подумать', drop: 'Отказаться' };

// ---------- charts (vanilla canvas, без библиотек) ----------
function cssVar(name, fallback = '#888') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawDonut(canvas, segments) {
  const { ctx, w, h } = setupCanvas(canvas);
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 6;
  const inner = r * 0.62;
  let a = -Math.PI / 2;
  segments.forEach((seg) => {
    const ang = (seg.value / total) * Math.PI * 2;
    if (ang <= 0) return;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a, a + ang);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    a += ang;
  });
  // вырезаем центр (донат)
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  // подпись в центре
  ctx.fillStyle = cssVar('--text', '#111');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '700 18px Inter, sans-serif';
  ctx.fillText(fmtShort(total), cx, cy - 4);
  ctx.fillStyle = cssVar('--muted', '#888');
  ctx.font = '500 11px Inter, sans-serif';
  ctx.fillText('грн распределено', cx, cy + 13);
}
function drawLine(canvas, points) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (points.length < 2) return;
  const padL = 8, padR = 8, padT = 14, padB = 22;
  const vals = points.map((p) => p.value);
  const maxV = Math.max(...vals, 0);
  const minV = Math.min(...vals, 0);
  const span = (maxV - minV) || 1;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const x = (i) => padL + (innerW * i) / (points.length - 1);
  const y = (v) => padT + innerH - ((v - minV) / span) * innerH;
  const accent = cssVar('--accent', '#2f6bff');
  // нулевая линия
  if (minV < 0) {
    ctx.strokeStyle = cssVar('--border', '#ddd');
    ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // заливка под линией
  const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
  grad.addColorStop(0, accent + '55');
  grad.addColorStop(1, accent + '00');
  ctx.beginPath();
  ctx.moveTo(x(0), y(points[0].value));
  points.forEach((p, i) => ctx.lineTo(x(i), y(p.value)));
  ctx.lineTo(x(points.length - 1), padT + innerH);
  ctx.lineTo(x(0), padT + innerH);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  // линия
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
  ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
  // точки
  points.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(x(i), y(p.value), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = p.value < 0 ? cssVar('--red', '#e44') : accent;
    ctx.fill();
    ctx.strokeStyle = cssVar('--panel', '#fff'); ctx.lineWidth = 1.5; ctx.stroke();
  });
}
function drawCharts() {
  const donut = $('#donutAlloc');
  if (donut && state.allocation) {
    const t = state.allocation.totals;
    const segs = [{ value: t.survival, color: '#64708f' }];
    Object.entries(state.allocation.buckets).filter(([, v]) => v > 0)
      .forEach(([k, v]) => segs.push({ value: v, color: layerColor(k) }));
    if (t.remaining > 0) segs.push({ value: t.remaining, color: cssVar('--border', '#ccd') });
    drawDonut(donut, segs);
  }
  const line = $('#lineBalance');
  if (line && state.allocation) {
    const t = state.allocation.totals;
    const pts = [{ value: t.salary - t.survival }];
    state.allocation.timeline.forEach((n) => pts.push({ value: n.balanceAfter }));
    drawLine(line, pts);
  }
}

// Клиентская копия логики вердикта (для живого отображения в модалке/таблице).
function clientVerdict(scoreType, scores) {
  if (!scoreType || scoreType === 'none' || !scores) return null;
  const crit = scoreType === 'full'
    ? [...(state.meta.scoreCriteria.quick), ...(state.meta.scoreCriteria.full)]
    : state.meta.scoreCriteria.quick;
  let sum = 0; let count = 0;
  for (const c of crit) {
    const v = Number(scores[c.id]);
    if (!v) continue;
    sum += c.dir === 'neg' ? (6 - v) : v;
    count += 1;
  }
  if (count === 0) return null;
  const score = Math.round((sum / count / 5) * 100);
  let verdict = 'reconsider';
  if (score >= 68) verdict = 'keep'; else if (score < 45) verdict = 'drop';
  return { score, verdict };
}

function prioDots(p) {
  let s = '<span class="prio">';
  for (let i = 1; i <= 5; i++) s += `<i class="${i <= p ? 'on' : ''}"></i>`;
  return s + '</span>';
}

// ---------- theme ----------
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('cq-theme', t); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0a1020' : '#ffffff');
  const icon = t === 'dark' ? '☀' : '☾';
  const a = $('#themeBtn'); if (a) a.textContent = icon;
  const b = $('#themeBtnAuth'); if (b) b.textContent = icon;
  if (typeof drawCharts === 'function') requestAnimationFrame(drawCharts);
}
function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
$('#themeBtn')?.addEventListener('click', toggleTheme);
$('#themeBtnAuth')?.addEventListener('click', toggleTheme);
applyTheme(currentTheme());

// ============================================================
// AUTH
// ============================================================
async function bootstrap() {
  const st = await api.get('/api/auth/status');
  if (st.authed) { await loadAndRender(); }
  else { showAuthGate(st.pinSet); }
}

function showAuthGate(pinSet = true) {
  $('#app').classList.add('hidden');
  const gate = $('#authGate');
  gate.classList.remove('hidden');
  const isSetup = pinSet === false;
  $('#authTitle').textContent = isSetup ? 'Создайте PIN' : 'Вход';
  $('#authHint').textContent = isSetup
    ? 'Это персональное приложение. Придумайте PIN (минимум 4 цифры).'
    : 'Введите PIN, чтобы открыть свой план.';
  $('#pinConfirm').classList.toggle('hidden', !isSetup);
  $('#authSubmit').textContent = isSetup ? 'Создать' : 'Войти';
  $('#authForm').dataset.mode = isSetup ? 'setup' : 'login';
  $('#pinInput').value = ''; $('#pinConfirm').value = ''; $('#authError').textContent = '';
  $('#pinInput').focus();
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.currentTarget.dataset.mode;
  const pin = $('#pinInput').value.trim();
  const err = $('#authError');
  err.textContent = '';
  try {
    if (mode === 'setup') {
      if (pin.length < 4) return (err.textContent = 'PIN слишком короткий.');
      if (pin !== $('#pinConfirm').value.trim()) return (err.textContent = 'PIN не совпадает.');
      await api.post('/api/auth/setup', { pin });
    } else {
      await api.post('/api/auth/login', { pin });
    }
    $('#authGate').classList.add('hidden');
    await loadAndRender();
  } catch (ex) {
    err.textContent = ex.message === 'bad_pin' ? 'Неверный PIN.' : 'Ошибка: ' + ex.message;
  }
});

$('#logoutBtn')?.addEventListener('click', doLogout);
$('#logoutBtnMobile')?.addEventListener('click', doLogout);
$('#fab')?.addEventListener('click', () => openQuickAddModal());
$('#settingsBtn')?.addEventListener('click', openSettingsModal);

// ---------- PWA: service worker + install prompt ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW:', e));
  });
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('#installBtn')?.classList.remove('hidden');
});
$('#installBtn')?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null;
  $('#installBtn')?.classList.add('hidden');
});
window.addEventListener('appinstalled', () => { $('#installBtn')?.classList.add('hidden'); });

// ============================================================
// LOAD + RENDER
// ============================================================
async function loadAndRender() {
  const data = await api.get(`/api/state?scenario=${state.scenario}`);
  state.meta = data.meta;
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.scenarios = data.scenarios;
  state.history = data.history;
  state.goals = data.goals || [];
  try { state.customInclude = (await api.get('/api/custom-scenario')).includeIds || []; } catch {}
  $('#app').classList.remove('hidden');
  renderTopbar();
  renderView();
}

async function refresh() {
  const data = await api.get(`/api/state?scenario=${state.scenario}`);
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.scenarios = data.scenarios;
  state.history = data.history;
  state.goals = data.goals || [];
  renderTopbar();
  renderView();
}

function renderTopbar() {
  $('#topPlanName').textContent = state.plan ? state.plan.name : 'Зарплата не настроена';
  $('#topPayday').textContent = state.plan
    ? `Зарплата ${fmtDate(state.plan.payday)} · ${fmt(state.plan.salary)}`
    : 'Нажмите «Настроить зарплату»';
  const badge = $('#topStatus');
  if (state.allocation) {
    const s = state.allocation.totals.status;
    badge.className = 'status-badge status-' + s;
    badge.textContent = STATUS_LABELS[s] || s;
    badge.classList.remove('hidden');
  } else { badge.classList.add('hidden'); }
}

$$('.nav-item[data-view]').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  $$('.nav-item[data-view]').forEach((x) => x.classList.toggle('active', x.dataset.view === b.dataset.view));
  renderView();
}));

async function doLogout() {
  await api.post('/api/auth/logout');
  location.reload();
}

$('#editPlanBtn').addEventListener('click', openPlanModal);

function renderView() {
  const root = $('#views');
  const v = state.view;
  if (v === 'dashboard') root.innerHTML = viewDashboard();
  else if (v === 'queue') root.innerHTML = viewQueue();
  else if (v === 'plan') root.innerHTML = viewPlan();
  else if (v === 'timeline') root.innerHTML = viewTimeline();
  else if (v === 'scenarios') root.innerHTML = viewScenarios();
  else if (v === 'history') root.innerHTML = viewHistory();
  else if (v === 'assistant') { root.innerHTML = viewAssistant(); initAssistant(); }
  // плавное появление вкладки
  root.classList.remove('view-enter');
  void root.offsetWidth;
  root.classList.add('view-enter');
  bindViewEvents();
  // FAB прячем там, где он не нужен (он открывает добавление желания)
  const fab = $('#fab');
  if (fab) fab.classList.toggle('hidden', !state.plan && v !== 'queue');
  requestAnimationFrame(drawCharts);
}

let _resizeT;
window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(drawCharts, 150); });

// ============================================================
// VIEWS
// ============================================================
function noPlanBlock() {
  return `<div class="empty"><div class="big">◎</div>
    <p>Сначала настройте будущую зарплату.</p>
    <button class="btn btn-primary" data-act="open-plan">Настроить зарплату</button></div>`;
}

// Скоро дедлайны — напоминание в Кабинете.
function upcomingDeadlines(days = 30) {
  const now = new Date();
  return state.items
    .filter((i) => i.deadline && i.status === 'active')
    .map((i) => ({ item: i, left: Math.ceil((new Date(i.deadline) - now) / 86400000) }))
    .filter((x) => x.left <= days)
    .sort((a, b) => a.left - b.left);
}
function remindersBlock() {
  const up = upcomingDeadlines(30);
  if (!up.length) return '';
  const items = up.slice(0, 4).map((x) => {
    const overdue = x.left < 0;
    const lbl = overdue ? `просрочено на ${-x.left} дн.` : x.left === 0 ? 'сегодня' : `через ${x.left} дн.`;
    return `<span class="rem-pill ${overdue ? 'rem-over' : ''}">${escapeHtml(x.item.title)} · ${lbl}</span>`;
  }).join('');
  return `<div class="reminders"><span class="rem-ico">⏰</span><div class="rem-list"><b>Скоро дедлайны:</b> ${items}</div></div>`;
}

// What-if: ползунок зарплаты с мгновенным пересчётом.
function whatIfBlock() {
  const base = state.plan.salary;
  const min = Math.max(0, Math.round((base * 0.6) / 500) * 500);
  const max = Math.round((base * 1.4) / 500) * 500;
  const aiCard = state.meta?.ai?.enabled
    ? `<div class="card pad-lg tip-card">
         <div class="row-between"><div class="stat-label">✦ Совет от AI</div>
           <button class="btn btn-sm btn-outline" data-act="ai-tip">Обновить</button></div>
         <div id="aiTip" class="tip-body muted">Нажмите «Обновить», чтобы получить совет по вашему плану.</div>
       </div>`
    : '';
  return `
  <div class="chart-cols" style="margin-top:16px">
    <div class="card pad-lg">
      <div class="row-between"><div class="stat-label">Что если зарплата изменится?</div>
        <span id="whatifVal" class="stat-value sm accent-num">${fmt(base)}</span></div>
      <input id="whatifSlider" type="range" min="${min}" max="${max}" step="500" value="${base}" style="width:100%;margin-top:12px;accent-color:var(--accent)">
      <div class="row-between small muted"><span>${fmtShort(min)}</span><span>${fmtShort(max)}</span></div>
      <div id="whatifOut" class="whatif-out"></div>
      <button class="btn btn-sm btn-primary hidden" id="whatifApply" data-act="whatif-apply" style="margin-top:10px">Применить как новую зарплату</button>
    </div>
    ${aiCard}
  </div>`;
}

function goalsBlock() {
  const goals = state.goals || [];
  const rows = goals.map((g) => {
    const pct = g.target > 0 ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0;
    const done = pct >= 100;
    return `<div class="goal" data-goal="${g.id}">
      <div class="goal-top"><div class="goal-name">${escapeHtml(g.title)}${done ? ' <span class="verdict verdict-keep">готово</span>' : ''}</div>
        <div class="goal-actions">
          <button class="btn btn-sm btn-ghost" data-act="goal-add" data-id="${g.id}">+ внести</button>
          <button class="btn btn-sm btn-ghost" data-act="goal-del" data-id="${g.id}" title="Удалить">✕</button>
        </div></div>
      <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
      <div class="row-between small muted"><span>${fmt(g.saved)} из ${fmt(g.target)}</span><span>${pct}%${g.deadline ? ' · до ' + fmtDate(g.deadline) : ''}</span></div>
    </div>`;
  }).join('');
  return `
  <div class="section-title row-between"><span>Цели-накопления · ${goals.length}</span>
    <button class="btn btn-sm btn-outline" data-act="goal-add-new">+ Цель</button></div>
  ${goals.length ? `<div class="goals">${rows}</div>` : '<p class="muted">Целей пока нет. Добавьте первую — например, «Подушка 10 000 грн».</p>'}`;
}

function viewDashboard() {
  if (!state.plan || !state.allocation) {
    return `<div class="view-head"><h1>Кабинет</h1><p>Обзор будущей зарплаты до её прихода.</p></div>${noPlanBlock()}`;
  }
  const t = state.allocation.totals;
  const segs = Object.entries(state.allocation.buckets)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<div class="alloc-seg" style="width:${(v / t.salary) * 100}%;background:${bucketColor(k)}" title="${bucketLabel(k)}: ${fmt(v)}"></div>`)
    .join('');
  const survW = (t.survival / t.salary) * 100;

  return `
  <div class="view-head"><h1>Кабинет</h1><p>Как разложить зарплату заранее — до того, как деньги пришли.</p></div>
  ${remindersBlock()}
  <div class="grid cards">
    <div class="card"><div class="stat-label">Зарплата</div><div class="stat-value">${fmt(t.salary)}</div><div class="stat-sub">${fmtDate(state.plan.payday)}</div></div>
    <div class="card"><div class="stat-label">Обязательные расходы</div><div class="stat-value sm">${fmt(t.survival)}</div><div class="stat-sub">списываются первыми</div></div>
    <div class="card"><div class="stat-label">Защищённый буфер</div><div class="stat-value sm accent-num">${fmt(t.buffer)}</div><div class="stat-sub">не трогаем</div></div>
    <div class="card"><div class="stat-label">Доступно распределить</div><div class="stat-value accent-num">${fmt(t.availableToAllocate)}</div></div>
    <div class="card"><div class="stat-label">Распределено</div><div class="stat-value sm">${fmt(t.allocated)}</div><div class="stat-sub">${state.allocation.approved.length} покупок одобрено</div></div>
    <div class="card"><div class="stat-label">Останется</div><div class="stat-value ${t.freeAfterBuffer < 0 ? 'red-num' : 'green-num'}">${fmt(t.remaining)}</div><div class="stat-sub">сверх буфера: ${fmt(t.freeAfterBuffer)}</div></div>
  </div>

  <div class="chart-cols" style="margin-top:16px">
    <div class="card pad-lg">
      <div class="row-between"><div class="stat-label">Распределение по слоям</div>
        <span class="status-badge status-${t.status}">${STATUS_LABELS[t.status]}</span></div>
      <div class="donut-wrap">
        <canvas id="donutAlloc" class="chart-donut"></canvas>
        <div class="legend legend-col">
          <span><span class="dot" style="background:#64708f"></span>Обязательные <b>${fmt(t.survival)}</b></span>
          ${Object.entries(state.allocation.buckets).filter(([, v]) => v > 0).map(([k, v]) => `<span><span class="dot" style="background:${bucketColor(k)}"></span>${bucketLabel(k)} <b>${fmt(v)}</b></span>`).join('')}
          <span><span class="dot" style="background:var(--border)"></span>Останется <b>${fmt(t.remaining)}</b></span>
        </div>
      </div>
      <div class="alloc-bar" style="margin-top:16px">
        <div class="alloc-seg" style="width:${survW}%;background:#64708f"></div>${segs}
      </div>
      ${t.status === 'overallocated' ? `<div class="tradeoff" style="background:color-mix(in srgb,var(--red) 10%,transparent);border-color:var(--red)"><b style="color:var(--red)">Перерасход.</b> Часть покупок не помещается без нарушения буфера — посмотрите «План распределения», что перенести.</div>` : ''}
    </div>
    <div class="card pad-lg">
      <div class="stat-label">Остаток после каждой покупки</div>
      ${state.allocation.timeline.length ? `<canvas id="lineBalance" class="chart-line"></canvas>
      <div class="row-between small muted" style="margin-top:6px"><span>старт ${fmtShort(t.salary - t.survival)}</span><span>буфер ${fmtShort(t.buffer)}</span></div>`
      : '<div class="chart-empty muted">Добавьте покупки в план, чтобы увидеть график остатка.</div>'}
    </div>
  </div>

  ${whatIfBlock()}
  ${goalsBlock()}

  <div class="section-title">Одобрено в этой зарплате · ${state.allocation.approved.length}</div>
  ${state.allocation.approved.length ? state.allocation.approved.map((a) => queueItemRow(a.item, `Остаток после: ${fmt(a.balanceAfter)}`)).join('') : '<p class="muted">Пока ничего не одобрено — добавьте желания в очередь.</p>'}

  ${state.allocation.deferred.length ? `<div class="section-title">Перенести на потом · ${state.allocation.deferred.length}</div>
    ${state.allocation.deferred.map((d) => queueItemRow(d.item, '', d.reason)).join('')}` : ''}
  `;
}

function verdictChip(item) {
  const v = clientVerdict(item.scoreType, item.scores);
  if (!v) return '';
  return ` <span class="verdict verdict-${v.verdict}" title="Оценка ${v.score}/100">${VERDICT_LABELS[v.verdict]} ${v.score}</span>`;
}

function queueItemRow(item, extra = '', reason = '') {
  const layer = item.layer || item.bucket;
  return `<div class="queue-item">
    <div class="qi-main">
      <div class="qi-title"><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(item.title)}
        <span class="tag tag-${item.type}">${TYPE_LABELS[item.type]}</span>${verdictChip(item)}</div>
      <div class="qi-meta">${layerLabel(layer)} · ${catLabelShort(item.category)} · ${bandLabel(item.band)} · приоритет ${item.priority}/5 · траектория ${item.trajectory}/5${item.deadline ? ' · дедлайн ' + fmtDate(item.deadline) : ''}</div>
      ${reason ? `<div class="reason">↪ ${reason}</div>` : ''}
      ${extra ? `<div class="qi-meta">${extra}</div>` : ''}
    </div>
    <div class="qi-cost">${fmt(item.cost)}</div>
  </div>`;
}

// Применить поиск/фильтры/сортировку к списку желаний.
function filteredItems() {
  const f = state.queue;
  let arr = state.items.slice();
  if (f.q) {
    const q = f.q.toLowerCase();
    arr = arr.filter((it) => it.title.toLowerCase().includes(q)
      || catLabelShort(it.category).toLowerCase().includes(q)
      || layerLabel(it.layer || it.bucket).toLowerCase().includes(q));
  }
  if (f.layer) arr = arr.filter((it) => (it.layer || it.bucket) === f.layer);
  if (f.type) arr = arr.filter((it) => it.type === f.type);
  if (f.band) arr = arr.filter((it) => it.band === f.band);
  const val = SORT_VAL[f.sortKey] || SORT_VAL.priority;
  const dir = f.sortDir === 'asc' ? 1 : -1;
  return arr.sort((a, b) => {
    const va = val(a); const vb = val(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return b.priority - a.priority;
  });
}

// Извлечение значения для сортировки по ключу колонки.
const SORT_VAL = {
  title: (it) => it.title.toLowerCase(),
  cost: (it) => it.cost,
  layer: (it) => layerLabel(it.layer || it.bucket).toLowerCase(),
  category: (it) => catLabelShort(it.category).toLowerCase(),
  band: (it) => state.meta.bands.findIndex((b) => b.id === it.band),
  type: (it) => ({ must: 0, should: 1, nice: 2 }[it.type] ?? 3),
  priority: (it) => it.priority,
  trajectory: (it) => it.trajectory,
  deadline: (it) => (it.deadline ? new Date(it.deadline).getTime() : Infinity),
};
// Направление по умолчанию при первом клике на колонку.
const SORT_DEFAULT_DIR = {
  title: 'asc', cost: 'desc', layer: 'asc', category: 'asc',
  band: 'desc', type: 'asc', priority: 'desc', trajectory: 'desc', deadline: 'asc',
};

// Заголовок-колонка с сортировкой по клику (стрелка показывает направление).
function sortableTh(key, label, f) {
  const active = f.sortKey === key;
  const arrow = active ? (f.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  return `<th class="sortable${active ? ' sorted' : ''}" data-sort="${key}" title="Сортировать по «${label}»">${label}${arrow}</th>`;
}

function viewQueue() {
  const f = state.queue;
  const sortVal = `${f.sortKey}:${f.sortDir}`;
  const items = filteredItems();
  const opt = (val, label, sel) => `<option value="${val}" ${sel === val ? 'selected' : ''}>${label}</option>`;
  const layerOpts = ['<option value="">Все слои</option>']
    .concat(Object.entries(state.meta.layers).map(([k, v]) => opt(k, v.ru, f.layer))).join('');
  const bandOpts = ['<option value="">Все размеры</option>']
    .concat(state.meta.bands.map((b) => opt(b.id, b.ru || b.label, f.band))).join('');

  const rows = items.map((it) => {
    const inPlan = state.allocation?.approved.some((a) => a.item.id === it.id);
    const layer = it.layer || it.bucket;
    return `<tr data-id="${it.id}">
      <td><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(it.title)}${verdictChip(it)}</td>
      <td>${fmt(it.cost)}</td>
      <td>${layerLabel(layer)}</td>
      <td>${catLabelShort(it.category)}</td>
      <td><span class="band">${bandLabel(it.band)}</span></td>
      <td><span class="tag tag-${it.type}">${TYPE_LABELS[it.type]}</span></td>
      <td>${prioDots(it.priority)}</td>
      <td>${it.deadline ? fmtDate(it.deadline) : '—'}</td>
      <td>${inPlan ? '<span class="green-num">в плане</span>' : '<span class="muted">позже</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm btn-ghost" data-act="tradeoff" data-id="${it.id}">Trade-off</button>
        ${state.meta?.ai?.enabled ? `<button class="btn btn-sm btn-ghost" data-act="explain" data-id="${it.id}" title="Почему AI советует так?">✦</button>` : ''}
        <button class="btn btn-sm btn-outline" data-act="edit" data-id="${it.id}">✎</button>
        <button class="btn btn-sm btn-ghost" data-act="bought" data-id="${it.id}" title="Отметить купленным">✓</button>
      </td>
    </tr>`;
  }).join('');

  // мобильные карточки со свайпом
  const cards = items.map((it) => {
    const inPlan = state.allocation?.approved.some((a) => a.item.id === it.id);
    const layer = it.layer || it.bucket;
    return `<div class="swipe-wrap" data-id="${it.id}">
      <div class="swipe-bg">
        <span class="swipe-left">✓ куплено</span>
        <span class="swipe-right">🗑 удалить</span>
      </div>
      <div class="swipe-card" data-id="${it.id}">
        <div class="qi-main">
          <div class="qi-title"><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(it.title)}
            <span class="tag tag-${it.type}">${TYPE_LABELS[it.type]}</span>${verdictChip(it)}</div>
          <div class="qi-meta">${layerLabel(layer)} · ${bandLabel(it.band)} · приоритет ${it.priority}/5${it.deadline ? ' · ' + fmtDate(it.deadline) : ''} ${inPlan ? '· <span class="green-num">в плане</span>' : ''}</div>
        </div>
        <div class="qi-cost">${fmt(it.cost)}<button class="btn btn-sm btn-outline" data-act="edit" data-id="${it.id}" style="margin-top:6px">✎</button></div>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="view-head row-between">
    <div><h1>Очередь желаний</h1><p>Единый список — переносится из месяца в месяц. Купленное архивируется.</p></div>
    <button class="btn btn-primary" data-act="add-item">+ Добавить желание</button>
  </div>

  <form class="quick-add" id="quickAddInline" autocomplete="off">
    <input name="title" placeholder="Быстро добавить: название" required />
    <input name="cost" type="number" min="0" placeholder="грн" />
    <button class="btn btn-primary" type="submit">+ Добавить</button>
  </form>

  <div class="queue-toolbar">
    <input id="qSearch" class="q-search" placeholder="🔍 Поиск по названию / категории" value="${escapeAttr(f.q)}" />
    <select id="qLayer">${layerOpts}</select>
    <select id="qType">${['<option value="">Все типы</option>', opt('must', 'Must', f.type), opt('should', 'Should', f.type), opt('nice', 'Nice', f.type)].join('')}</select>
    <select id="qBand">${bandOpts}</select>
    <select id="qSort" class="mobile-only">${[
      opt('priority:desc', 'Сортировка: приоритет', sortVal), opt('cost:desc', 'Дороже', sortVal),
      opt('cost:asc', 'Дешевле', sortVal), opt('deadline:asc', 'Дедлайн', sortVal),
      opt('trajectory:desc', 'Долгосрочность', sortVal), opt('title:asc', 'По названию', sortVal)].join('')}</select>
  </div>

  ${state.items.length ? (items.length ? `
    <div class="table-wrap desktop-only"><table>
      <thead><tr>${[
        ['title', 'Желание'], ['cost', 'Стоимость'], ['layer', 'Слой'], ['category', 'Категория'],
        ['band', 'Band'], ['type', 'Тип'], ['priority', 'Приоритет'], ['deadline', 'Дедлайн'],
      ].map(([k, label]) => sortableTh(k, label, f)).join('')}<th>Статус</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="swipe-list mobile-only">${cards}<p class="swipe-hint muted small">Свайп влево — куплено · вправо — удалить</p></div>`
    : '<div class="empty"><div class="big">🔍</div><p>Ничего не найдено по фильтрам.</p></div>')
    : `<div class="empty"><div class="big">≡</div><p>Очередь пуста. Добавьте первое желание.</p>
       <button class="btn btn-primary" data-act="add-item">+ Добавить желание</button></div>`}
  <div id="explainBox"></div>
  <div id="tradeoffBox"></div>`;
}

function viewPlan() {
  if (!state.allocation) return `<div class="view-head"><h1>План распределения</h1></div>${noPlanBlock()}`;
  const a = state.allocation;
  return `
  <div class="view-head row-between">
    <div><h1>План распределения</h1><p>Авто-распределение: сначала обязательное и дедлайны, потом приоритет и долгосрочная ценность.</p></div>
    <button class="btn btn-outline" data-act="close-month">Закрыть месяц</button>
  </div>
  <div class="plan-cols">
    <div>
      <div class="section-title green-num">Одобрено в этой зарплате · ${a.approved.length}</div>
      ${a.approved.length ? a.approved.map((x) => queueItemRow(x.item, `Остаток после покупки: ${fmt(x.balanceAfter)}`)).join('') : '<p class="muted">Ничего не одобрено.</p>'}
    </div>
    <div>
      <div class="section-title amber-num">Перенести на потом · ${a.deferred.length}</div>
      ${a.deferred.length ? a.deferred.map((x) => queueItemRow(x.item, '', x.reason)).join('') : '<p class="muted">Всё помещается — отложенного нет.</p>'}
    </div>
  </div>`;
}

function viewTimeline() {
  if (!state.allocation) return `<div class="view-head"><h1>Таймлайн</h1></div>${noPlanBlock()}`;
  const tl = state.allocation.timeline;
  return `
  <div class="view-head"><h1>Таймлайн покупок</h1><p>План по датам после зарплаты с остатком на счёте после каждой покупки.</p></div>
  ${tl.length ? `<div class="card pad-lg" style="margin-bottom:16px">
    <div class="stat-label">График остатка</div>
    <canvas id="lineBalance" class="chart-line"></canvas>
  </div>` : ''}
  <div class="card pad-lg">
    <div class="row-between"><div class="stat-label">Старт — зарплата ${fmtDate(state.plan.payday)}</div>
      <div class="stat-value sm">${fmt(state.allocation.totals.salary - state.allocation.totals.survival)} <span class="muted small">после обязательных</span></div></div>
    ${tl.length ? `<div class="timeline" style="margin-top:18px">
      ${tl.map((n) => `<div class="tl-node">
        <div class="tl-date">${fmtDate(n.date)}</div>
        <div class="tl-card"><div><b>${escapeHtml(n.item.title)}</b> <span class="muted small">${fmt(n.item.cost)}</span></div>
          <div class="tl-bal">остаток ${fmt(n.balanceAfter)}</div></div>
      </div>`).join('')}
      <div class="tl-node"><div class="tl-date">Итог</div>
        <div class="tl-card"><div><b>Защищённый буфер</b></div><div class="tl-bal accent-num">${fmt(state.allocation.totals.buffer)}</div></div></div>
    </div>` : '<p class="muted" style="margin-top:14px">Нет запланированных покупок.</p>'}
  </div>`;
}

function viewScenarios() {
  if (!state.scenarios.length) return `<div class="view-head"><h1>Сценарии</h1></div>${noPlanBlock()}`;
  const cards = state.scenarios.map((s) => {
    const total = s.allocated + s.remaining || 1;
    const bars = Object.entries(s.buckets).filter(([, v]) => v > 0)
      .map(([k, v]) => `<div style="width:${(v / total) * 100}%;background:${bucketColor(k)}"></div>`).join('');
    return `<div class="card scn-card ${s.key === state.scenario ? 'active' : ''}" data-act="pick-scenario" data-key="${s.key}">
      <div class="row-between"><div class="scn-name">${s.label}</div>
        <span class="status-badge status-${s.status}">${STATUS_LABELS[s.status]}</span></div>
      <div class="bucket-bar">${bars}<div style="flex:1;background:#142244"></div></div>
      <div class="legend small">
        <span class="muted">Карьера: ${fmtShort(s.career)}</span>
        <span class="muted">Жизнь: ${fmtShort(s.quality)}</span>
        <span class="muted">Буфер: ${fmtShort(s.buffer)}</span>
      </div>
      <div style="margin-top:10px;display:flex;justify-content:space-between">
        <span class="muted small">Включено ${s.includedCount} · позже ${s.excludedCount}</span>
        <b class="green-num">${fmt(s.remaining)}</b>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="view-head"><h1>Сценарии месяца</h1><p>Сравните стратегии распределения и выберите ту, что выглядит сбалансированной. Выбранный сценарий применяется ко всем экранам.</p></div>
  <div class="grid scn-grid">${cards}</div>
  ${scenarioCompare()}
  ${state.scenario === 'custom' ? customScenarioEditor() : ''}`;
}

// Сравнение сценариев бок о бок (на ПК — колонки, на телефоне — горизонтальный скролл).
function scenarioCompare() {
  const sc = state.scenarios;
  if (sc.length < 2) return '';
  const row = (label, fn, cls = '') => `<tr><th>${label}</th>${sc.map((s) => `<td class="${cls}">${fn(s)}</td>`).join('')}</tr>`;
  return `
  <div class="section-title">Сравнение бок о бок</div>
  <div class="table-wrap"><table class="cmp-table">
    <thead><tr><th></th>${sc.map((s) => `<th class="${s.key === state.scenario ? 'cmp-active' : ''}">
        <button class="btn btn-sm ${s.key === state.scenario ? 'btn-primary' : 'btn-outline'}" data-act="pick-scenario" data-key="${s.key}">${s.label}</button>
      </th>`).join('')}</tr></thead>
    <tbody>
      ${row('Статус', (s) => `<span class="status-badge status-${s.status}">${STATUS_LABELS[s.status]}</span>`)}
      ${row('Карьера', (s) => fmt(s.career))}
      ${row('Качество жизни', (s) => fmt(s.quality))}
      ${row('Буфер', (s) => fmt(s.buffer))}
      ${row('Распределено', (s) => fmt(s.allocated))}
      ${row('Останется', (s) => `<b class="${s.remaining < 0 ? 'red-num' : 'green-num'}">${fmt(s.remaining)}</b>`)}
      ${row('Одобрено', (s) => `${s.includedCount}`)}
      ${row('Отложено', (s) => `${s.excludedCount}`)}
    </tbody>
  </table></div>`;
}

function customScenarioEditor() {
  const rows = state.items.map((it) => `<label class="queue-item" style="cursor:pointer">
    <div class="qi-main"><div class="qi-title">${escapeHtml(it.title)} <span class="tag tag-${it.type}">${TYPE_LABELS[it.type]}</span></div>
      <div class="qi-meta">${catLabel(it.category)} · ${fmt(it.cost)}</div></div>
    <input type="checkbox" data-cust="${it.id}" ${state.customInclude.includes(it.id) ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent)">
  </label>`).join('');
  return `<div class="section-title">Свой сценарий — выберите покупки вручную</div>${rows || '<p class="muted">Добавьте желания в очередь.</p>'}`;
}

function viewHistory() {
  if (!state.history.length) {
    return `<div class="view-head"><h1>История решений</h1><p>Закрытые месяцы появятся здесь.</p></div>
      <div class="empty"><div class="big">↺</div><p>Пока нет закрытых месяцев.<br>Когда зарплата потрачена по плану — нажмите «Закрыть месяц» на экране плана.</p></div>`;
  }
  return `<div class="view-head"><h1>История решений</h1><p>Что ты решал в прошлые месяцы: купленное, отложенное, остаток.</p></div>
    ${state.history.map((h) => {
      const s = h.snapshot || {};
      const t = s.totals || {};
      return `<div class="card pad-lg" style="margin-bottom:14px">
        <div class="row-between"><div><b>${escapeHtml(h.name)}</b> <span class="muted small">· зарплата ${fmtDate(h.payday)} · закрыт ${fmtDate(h.closedAt)}</span></div>
          <span class="status-badge status-${t.status || 'safe'}">${STATUS_LABELS[t.status] || ''}</span></div>
        <div class="grid cards" style="margin-top:12px">
          <div class="card"><div class="stat-label">Зарплата</div><div class="stat-value sm">${fmt(t.salary || h.salary)}</div></div>
          <div class="card"><div class="stat-label">Распределено</div><div class="stat-value sm">${fmt(t.allocated)}</div></div>
          <div class="card"><div class="stat-label">Осталось</div><div class="stat-value sm green-num">${fmt(t.remaining)}</div></div>
        </div>
        <div style="margin-top:12px"><span class="muted small">Куплено:</span> ${(s.approved || []).map((x) => escapeHtml(x.title)).join(', ') || '—'}</div>
        <div style="margin-top:6px"><span class="muted small">Отложено:</span> ${(s.deferred || []).map((x) => escapeHtml(x.title)).join(', ') || '—'}</div>
      </div>`;
    }).join('')}`;
}

// ---------- assistant ----------
let chatHistory = [];
function viewAssistant() {
  const enabled = state.meta?.ai?.enabled;
  return `<div class="view-head"><h1>AI-ассистент</h1><p>Советует, что купить первым, что отложить и поясняет trade-off на основе твоего плана.</p></div>
  ${!enabled ? `<div class="tradeoff" style="background:rgba(245,177,61,.1);border-color:var(--amber)"><b style="color:var(--amber)">AI выключен.</b> Добавьте AI_PROVIDER и AI_API_KEY в окружение сервера, чтобы включить ассистента. Остальное приложение работает без него.</div>` : ''}
  <div class="chat">
    <div class="chip-row">
      <button class="chip" data-q="Что мне купить в первую очередь в этом месяце?">Что купить первым?</button>
      <button class="chip" data-q="Что лучше отложить на следующую зарплату и почему?">Что отложить?</button>
      <button class="chip" data-q="Мой план выглядит сбалансированным? Дай короткую оценку.">Оценка плана</button>
    </div>
    <div class="chat-log" id="chatLog"></div>
    <form class="chat-input" id="chatForm">
      <input id="chatInput" placeholder="Спросите про свой план..." ${enabled ? '' : 'disabled'} autocomplete="off" />
      <button class="btn btn-primary" type="submit" ${enabled ? '' : 'disabled'}>Спросить</button>
    </form>
  </div>`;
}
function initAssistant() {
  const log = $('#chatLog');
  log.innerHTML = chatHistory.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${escapeHtml(m.content)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
  $$('.chip').forEach((c) => c.addEventListener('click', () => { $('#chatInput').value = c.dataset.q; $('#chatForm').requestSubmit(); }));
  $('#chatForm')?.addEventListener('submit', sendChat);
}
async function sendChat(e) {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatHistory.push({ role: 'user', content: text });
  const log = $('#chatLog');
  log.innerHTML += `<div class="msg user">${escapeHtml(text)}</div><div class="msg bot typing" id="pending"><span class="dots"><i></i><i></i><i></i></span></div>`;
  log.scrollTop = log.scrollHeight;
  const pending = $('#pending');
  let acc = '';
  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory, scenario: state.scenario }),
    });
    if (res.status === 401) { showAuthGate(); return; }
    if (!res.ok || !res.body) throw new Error('stream ' + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    pending.classList.remove('typing');
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      pending.textContent = acc;
      log.scrollTop = log.scrollHeight;
    }
    chatHistory.push({ role: 'assistant', content: acc });
    pending.removeAttribute('id');
  } catch (ex) {
    // Фолбэк на обычный (нестриминговый) запрос.
    try {
      const out = await api.post('/api/ai/chat', { messages: chatHistory, scenario: state.scenario });
      chatHistory.push({ role: 'assistant', content: out.reply });
      pending.classList.remove('typing');
      pending.textContent = out.reply;
      pending.removeAttribute('id');
    } catch (ex2) {
      pending.classList.remove('typing');
      pending.textContent = 'Ошибка ассистента: ' + ex2.message;
    }
  }
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

// ============================================================
// EVENTS (delegated)
// ============================================================
function bindViewEvents() {
  $$('[data-act]').forEach((el) => {
    if (el._bound) return; el._bound = true;
    el.addEventListener('click', async () => {
      const act = el.dataset.act;
      const id = Number(el.dataset.id);
      if (act === 'open-plan') openPlanModal();
      else if (act === 'add-item') openItemModal();
      else if (act === 'quick-add') openQuickAddModal();
      else if (act === 'edit') openItemModal(state.items.find((i) => i.id === id));
      else if (act === 'bought') await markBought(id);
      else if (act === 'defer') await deferItem(id);
      else if (act === 'delete-item') await deleteItem(id);
      else if (act === 'tradeoff') await showTradeoff(id);
      else if (act === 'explain') await explainItem(id, el);
      else if (act === 'close-month') closeMonth();
      else if (act === 'pick-scenario') pickScenario(el.dataset.key);
      else if (act === 'ai-tip') await loadAiTip();
      else if (act === 'whatif-apply') await applyWhatIf();
      else if (act === 'goal-add-new') openGoalModal();
      else if (act === 'goal-add') openGoalContribute(id);
      else if (act === 'goal-del') await deleteGoal(id);
      else if (act === 'open-settings') openSettingsModal();
    });
  });
  $$('[data-cust]').forEach((cb) => cb.addEventListener('change', saveCustomScenario));

  // What-if слайдер (живой пересчёт).
  const slider = $('#whatifSlider');
  if (slider && !slider._bound) {
    slider._bound = true;
    slider.addEventListener('input', () => runWhatIf(Number(slider.value)));
  }

  // Поиск/фильтры/сортировка в очереди.
  bindQueueControls();
  // Свайпы по карточкам на мобильном.
  bindSwipe();
}

// ---------- what-if ----------
let _whatifT;
function runWhatIf(salary) {
  $('#whatifVal').textContent = fmt(salary);
  const applyBtn = $('#whatifApply');
  applyBtn?.classList.toggle('hidden', salary === state.plan.salary);
  clearTimeout(_whatifT);
  _whatifT = setTimeout(async () => {
    try {
      const { allocation } = await api.get(`/api/whatif?scenario=${state.scenario}&salary=${salary}`);
      if (!allocation) return;
      const t = allocation.totals;
      const out = $('#whatifOut');
      if (!out) return;
      const delta = t.salary - state.plan.salary;
      out.innerHTML = `
        <div class="whatif-grid">
          <div><span class="muted small">Доступно</span><b>${fmt(t.availableToAllocate)}</b></div>
          <div><span class="muted small">Распределено</span><b>${fmt(t.allocated)}</b></div>
          <div><span class="muted small">Одобрено</span><b>${allocation.approved.length} / ${allocation.approved.length + allocation.deferred.length}</b></div>
          <div><span class="muted small">Останется</span><b class="${t.remaining < 0 ? 'red-num' : 'green-num'}">${fmt(t.remaining)}</b></div>
        </div>
        <div class="small muted" style="margin-top:6px">${delta === 0 ? 'Текущая зарплата' : delta > 0 ? `+${fmt(delta)} к текущей` : `${fmt(delta)} к текущей`} · статус: ${STATUS_LABELS[t.status]}</div>`;
    } catch (e) { console.warn(e); }
  }, 180);
}
async function applyWhatIf() {
  const salary = Number($('#whatifSlider').value);
  await api.post('/api/plan', {
    name: state.plan.name, payday: state.plan.payday, salary,
    survivalCost: state.plan.survivalCost, buffer: state.plan.buffer,
  });
  toast('Зарплата обновлена');
  await refresh();
}

// ---------- AI tip ----------
async function loadAiTip() {
  const box = $('#aiTip');
  if (!box) return;
  box.textContent = 'Думаю…';
  box.classList.add('muted');
  try {
    const out = await api.post('/api/ai/tip', { scenario: state.scenario });
    box.classList.remove('muted');
    box.textContent = out.reply || '—';
  } catch (e) {
    box.textContent = 'Не удалось получить совет: ' + e.message;
  }
}

// ---------- queue search/filter/sort + quick add inline ----------
function bindQueueControls() {
  const qa = $('#quickAddInline');
  if (qa && !qa._bound) {
    qa._bound = true;
    qa.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(qa);
      const title = String(f.get('title') || '').trim();
      if (!title) return;
      await api.post('/api/items', { title, cost: +f.get('cost') || 0, type: 'should' });
      toast('Добавлено в очередь');
      await refresh();
    });
  }
  const search = $('#qSearch');
  if (search && !search._bound) {
    search._bound = true;
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { state.queue.q = search.value; rerenderQueue(); }, 160);
    });
  }
  const bind = (sel, key) => {
    const el = $(sel);
    if (el && !el._bound) {
      el._bound = true;
      el.addEventListener('change', () => { state.queue[key] = el.value; rerenderQueue(); });
    }
  };
  bind('#qLayer', 'layer'); bind('#qType', 'type'); bind('#qBand', 'band');
  // мобильный выбор сортировки: значение вида "key:dir"
  const sortSel = $('#qSort');
  if (sortSel && !sortSel._bound) {
    sortSel._bound = true;
    sortSel.addEventListener('change', () => {
      const [key, dir] = sortSel.value.split(':');
      state.queue.sortKey = key; state.queue.sortDir = dir || 'desc';
      rerenderQueue();
    });
  }
  // сортировка по клику на заголовок колонки (ПК)
  $$('th.sortable').forEach((th) => {
    if (th._bound) return; th._bound = true;
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.queue.sortKey === key) {
        state.queue.sortDir = state.queue.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.queue.sortKey = key;
        state.queue.sortDir = SORT_DEFAULT_DIR[key] || 'desc';
      }
      rerenderQueue();
    });
  });
}
// Перерисовать только очередь, не теряя фокус всего приложения.
function rerenderQueue() {
  if (state.view !== 'queue') return;
  const root = $('#views');
  root.innerHTML = viewQueue();
  bindViewEvents();
}

// ---------- swipe gestures (mobile wishlist) ----------
function bindSwipe() {
  $$('.swipe-card').forEach((card) => {
    if (card._swipe) return; card._swipe = true;
    const wrap = card.closest('.swipe-wrap');
    const id = Number(wrap.dataset.id);
    let startX = 0; let dx = 0; let dragging = false;
    card.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX; dx = 0; dragging = true;
      card.style.transition = 'none';
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      dx = e.touches[0].clientX - startX;
      card.style.transform = `translateX(${dx}px)`;
      wrap.classList.toggle('reveal-left', dx > 24);
      wrap.classList.toggle('reveal-right', dx < -24);
    }, { passive: true });
    card.addEventListener('touchend', async () => {
      dragging = false;
      card.style.transition = 'transform .2s ease';
      const TH = 90;
      if (dx > TH) { card.style.transform = 'translateX(100%)'; await markBought(id); }
      else if (dx < -TH) { card.style.transform = 'translateX(-100%)'; await deleteItem(id); }
      else { card.style.transform = 'translateX(0)'; wrap.classList.remove('reveal-left', 'reveal-right'); }
    });
  });
}

async function markBought(id) {
  await api.post(`/api/items/${id}/status`, { status: 'bought' });
  toast('Отмечено как купленное');
  await refresh();
}

// Отложить: исключить из текущего распределения через canDefer + понизить приоритет не нужно;
// проще — убираем из custom include и помечаем как «можно отложить». Здесь делаем мягкий перенос:
// исключаем из плана, понижая приоритет до 1, чтобы движок поставил его в конец.
async function deferItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  await api.put(`/api/items/${id}`, { ...it, priority: 1, canDefer: true });
  toast('Перенесено на потом');
  await refresh();
}

async function deleteItem(id) {
  const it = state.items.find((i) => i.id === id);
  if (!confirm(`Удалить «${it ? it.title : 'желание'}» навсегда?`)) return;
  await api.del(`/api/items/${id}`);
  toast('Удалено');
  await refresh();
}

async function explainItem(id, el) {
  const box = $('#explainBox') || $('#tradeoffBox');
  if (box) { box.innerHTML = '<div class="tradeoff">✦ AI думает…</div>'; }
  try {
    const out = await api.post('/api/ai/explain', { id, scenario: state.scenario });
    if (box) box.innerHTML = `<div class="tradeoff"><b>✦ AI:</b> ${escapeHtml(out.reply || '—')}</div>`;
  } catch (e) {
    if (box) box.innerHTML = `<div class="tradeoff">Не удалось получить объяснение: ${escapeHtml(e.message)}</div>`;
  }
  box?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function showTradeoff(id) {
  const box = $('#tradeoffBox');
  const t = await api.get(`/api/tradeoff/${id}?scenario=${state.scenario}`);
  const item = state.items.find((i) => i.id === id);
  let html;
  if (t.approved) {
    html = `<b>${escapeHtml(item.title)}</b> уже в плане. Если отказаться — освободится <b>${fmt(t.freedIfRemoved)}</b>, останется <b>${fmt(t.remainingIfRemoved)}</b>.`;
  } else {
    html = `Если купить <b>${escapeHtml(item.title)}</b> (${fmt(item.cost)}) — останется <b>${fmt(t.remainingIfAdded)}</b>.`;
    if (t.belowBuffer) html += ` ⚠️ Буфер опустится ниже безопасного уровня.`;
    if (t.displaces?.length) html += `<br>Это вытеснит: ${t.displaces.map((d) => escapeHtml(d.title)).join(', ')}.`;
  }
  box.innerHTML = `<div class="tradeoff">${html}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function closeMonth() {
  if (!confirm('Закрыть месяц? Одобренные покупки уйдут в архив (купленные), отложенные останутся в очереди на следующую зарплату.')) return;
  await api.post('/api/plan/close', { scenario: state.scenario });
  toast('Месяц закрыт и сохранён в истории');
  await refresh();
}

async function pickScenario(key) {
  state.scenario = key;
  await refresh();
}

async function saveCustomScenario() {
  const ids = $$('[data-cust]').filter((c) => c.checked).map((c) => Number(c.dataset.cust));
  state.customInclude = ids;
  await api.post('/api/custom-scenario', { includeIds: ids });
  if (state.scenario === 'custom') await refresh();
}

// ============================================================
// MODALS
// ============================================================
function openModal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-overlay" id="ov">${html}</div>`;
  $('#ov').addEventListener('click', (e) => { if (e.target.id === 'ov') closeModal(); });
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

function openPlanModal() {
  const p = state.plan || { name: 'Зарплата', payday: new Date().toISOString().slice(0, 10), ...state.meta.defaults };
  openModal(`<div class="modal">
    <div class="modal-head"><h2>Будущая зарплата</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="planForm" class="form-grid">
      <div class="field full"><label>Название (например, «Зарплата июнь»)</label><input name="name" value="${escapeAttr(p.name)}" /></div>
      <div class="field"><label>Дата зарплаты</label><input type="date" name="payday" value="${p.payday}" /></div>
      <div class="field"><label>Сумма зарплаты, грн</label><input type="number" name="salary" value="${p.salary}" min="0" /></div>
      <div class="field"><label>Обязательные расходы, грн</label><input type="number" name="survivalCost" value="${p.survivalCost}" min="0" />
        <span class="muted small">по умолчанию для жизни с родителями</span></div>
      <div class="field"><label>Защищённый буфер, грн</label><input type="number" name="buffer" value="${p.buffer}" min="0" />
        <span class="muted small">минимальный остаток, который нельзя трогать</span></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $('#planForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post('/api/plan', {
      name: f.get('name'), payday: f.get('payday'),
      salary: +f.get('salary'), survivalCost: +f.get('survivalCost'), buffer: +f.get('buffer'),
    });
    closeModal(); toast('Зарплата сохранена'); await refresh();
  });
}

// Быстрое добавление желания (одна строка).
function openQuickAddModal() {
  openModal(`<div class="modal modal-sheet">
    <div class="modal-head"><h2>Быстро добавить</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="quickForm" class="form-grid">
      <div class="field full"><label>Что хочешь?</label><input name="title" placeholder="Например, «Беспроводные наушники»" required autofocus /></div>
      <div class="field"><label>Стоимость, грн</label><input type="number" name="cost" min="0" placeholder="0" /></div>
      <div class="field"><label>Важность</label><select name="type">
        <option value="must">Обязательно</option><option value="should" selected>Желательно</option><option value="nice">По желанию</option>
      </select></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Добавить</button>
      </div>
    </form></div>`);
  $('#quickForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post('/api/items', { title: String(f.get('title')).trim(), cost: +f.get('cost') || 0, type: f.get('type') });
    closeModal(); toast('Добавлено в очередь'); await refresh();
  });
}

// ---------- goals ----------
function openGoalModal() {
  openModal(`<div class="modal modal-sheet">
    <div class="modal-head"><h2>Новая цель-накопление</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="goalForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="title" placeholder="Например, «Подушка безопасности»" required autofocus /></div>
      <div class="field"><label>Цель, грн</label><input type="number" name="target" min="0" value="10000" /></div>
      <div class="field"><label>Уже отложено, грн</label><input type="number" name="saved" min="0" value="0" /></div>
      <div class="field full"><label>Дедлайн (необязательно)</label><input type="date" name="deadline" /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Создать</button>
      </div>
    </form></div>`);
  $('#goalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post('/api/goals', {
      title: f.get('title'), target: +f.get('target') || 0, saved: +f.get('saved') || 0, deadline: f.get('deadline') || null,
    });
    closeModal(); toast('Цель создана'); await refresh();
  });
}

function openGoalContribute(id) {
  const g = state.goals.find((x) => x.id === id);
  if (!g) return;
  openModal(`<div class="modal modal-sheet">
    <div class="modal-head"><h2>Внести в «${escapeHtml(g.title)}»</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="contribForm" class="form-grid">
      <div class="field full"><label>Сколько добавить, грн</label><input type="number" name="amount" min="0" value="500" autofocus /></div>
      <div class="muted small">Сейчас: ${fmt(g.saved)} из ${fmt(g.target)}</div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Внести</button>
      </div>
    </form></div>`);
  $('#contribForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = +new FormData(e.currentTarget).get('amount') || 0;
    await api.put(`/api/goals/${id}`, { saved: (g.saved || 0) + amount });
    closeModal(); toast('Зачислено'); await refresh();
  });
}

async function deleteGoal(id) {
  const g = state.goals.find((x) => x.id === id);
  if (!confirm(`Удалить цель «${g ? g.title : ''}»?`)) return;
  await api.del(`/api/goals/${id}`);
  toast('Цель удалена'); await refresh();
}

// ---------- settings: export / import ----------
function openSettingsModal() {
  openModal(`<div class="modal modal-sheet">
    <div class="modal-head"><h2>Данные и резервная копия</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <div class="form-grid">
      <div class="field full"><label>Экспорт</label>
        <p class="muted small">Скачать всё (план, желания, цели, история) в JSON-файл.</p>
        <button class="btn btn-outline" id="exportBtn" type="button">⤓ Скачать бэкап (JSON)</button></div>
      <div class="field full"><label>Импорт</label>
        <p class="muted small">Восстановить из ранее скачанного файла. Желания добавятся к текущим.</p>
        <input type="file" id="importFile" accept="application/json,.json" />
        <div id="importMsg" class="muted small"></div></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-primary" onclick="document.getElementById('modalRoot').innerHTML=''">Готово</button>
      </div>
    </div></div>`);
  $('#exportBtn').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', importData);
}

async function exportData() {
  try {
    const res = await fetch('/api/export');
    if (!res.ok) throw new Error('export ' + res.status);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `capital-queue-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Бэкап скачан');
  } catch (e) { toast('Ошибка экспорта: ' + e.message); }
}

async function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const msg = $('#importMsg');
  try {
    const data = JSON.parse(await file.text());
    const out = await api.post('/api/import', { items: data.items, plan: data.plan, goals: data.goals });
    if (msg) msg.textContent = `Импортировано желаний: ${out.importedItems}.`;
    toast('Данные импортированы');
    await refresh();
  } catch (err) {
    if (msg) msg.textContent = 'Не удалось прочитать файл: ' + err.message;
  }
}

function clientBand(cost) {
  const c = Number(cost) || 0;
  for (const b of state.meta.bands) { if (b.max == null || c < b.max) return b.id; }
  return 'major';
}

function openItemModal(item) {
  const i = item || {
    title: '', cost: '', category: 'lifestyle', layer: '', priority: 3, type: 'should',
    deadline: '', earliestDate: '', canDefer: true, emotional: 3, trajectory: 3, notes: '',
    scoreType: 'none', scores: {},
  };
  const scores = i.scores || {};
  const catOpts = state.meta.categories
    .map((c) => `<option value="${c.id}" ${c.id === i.category ? 'selected' : ''}>${c.ru} · ${c.label}</option>`).join('');
  const layerOpts = Object.entries(state.meta.layers)
    .map(([k, v]) => `<option value="${k}" ${k === (i.layer || i.bucket) ? 'selected' : ''}>${v.ru} · ${v.label}</option>`).join('');
  const range = (name, val, label) => `<div class="field"><label>${label}</label><div class="range-row">
      <input type="range" name="${name}" min="1" max="5" value="${val}" oninput="this.nextElementSibling.textContent=this.value">
      <span class="range-val">${val}</span></div></div>`;
  const critRow = (c) => `<div class="score-row" data-crit="${c.id}">
      <div><div class="sr-label">${c.ru} ${c.dir === 'neg' ? '<span class="muted small">(чем меньше — тем лучше)</span>' : ''}</div><div class="sr-hint">${c.hint}</div></div>
      <div class="range-row"><input type="range" class="score-input" data-id="${c.id}" data-dir="${c.dir}" min="1" max="5" value="${scores[c.id] || 3}">
        <span class="range-val">${scores[c.id] || 3}</span></div>
    </div>`;
  const quickRows = state.meta.scoreCriteria.quick.map(critRow).join('');
  const fullRows = state.meta.scoreCriteria.full.map(critRow).join('');

  openModal(`<div class="modal">
    <div class="modal-head"><h2>${item ? 'Редактировать желание' : 'Новое желание'}</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="itemForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="title" value="${escapeAttr(i.title)}" required /></div>
      <div class="field"><label>Стоимость, грн</label><input type="number" id="costInput" name="cost" value="${i.cost}" min="0" required /></div>
      <div class="field"><label>Band (авто по сумме)</label><input id="bandDisplay" value="" disabled style="opacity:.8" /></div>
      <div class="field"><label>Категория покупки</label><select name="category" id="catSelect">${catOpts}</select></div>
      <div class="field"><label>Слой капитала</label><select name="layer" id="layerSelect">${layerOpts}</select>
        <span class="hint">Подставляется из категории, можно изменить.</span></div>
      <div class="field"><label>Тип</label><select name="type">
        <option value="must" ${i.type === 'must' ? 'selected' : ''}>Must-have (обязательно)</option>
        <option value="should" ${i.type === 'should' ? 'selected' : ''}>Should-have (желательно)</option>
        <option value="nice" ${i.type === 'nice' ? 'selected' : ''}>Nice-to-have (по желанию)</option>
      </select></div>
      ${range('priority', i.priority, 'Приоритет 1–5')}
      <div class="field"><label>Дедлайн (если есть)</label><input type="date" name="deadline" value="${i.deadline || ''}" /></div>
      <div class="field"><label>Не раньше даты (если есть)</label><input type="date" name="earliestDate" value="${i.earliestDate || ''}" /></div>
      ${range('emotional', i.emotional, 'Эмоциональное желание 1–5')}
      ${range('trajectory', i.trajectory, 'Долгосрочная ценность 1–5')}
      <div class="field full"><label class="switch-row"><input type="checkbox" name="canDefer" ${i.canDefer ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent)"> Можно отложить на следующую зарплату</label></div>
      <div class="field full"><label>Заметки</label><textarea name="notes">${escapeHtml(i.notes || '')}</textarea></div>

      <div class="subhead">Оценка покупки</div>
      <div class="field full"><label>Тип оценки</label><select name="scoreType" id="scoreType">
        <option value="none" ${i.scoreType === 'none' ? 'selected' : ''}>Без оценки</option>
        <option value="quick" ${i.scoreType === 'quick' ? 'selected' : ''}>Quick — 5 критериев (для Medium)</option>
        <option value="full" ${i.scoreType === 'full' ? 'selected' : ''}>Full — 13 критериев (для Large / Major)</option>
      </select><span class="hint" id="scoreHint"></span></div>
      <div class="field full hidden" id="verdictBanner"></div>
      <div class="field full hidden" id="quickWrap"><div class="score-grid">${quickRows}</div></div>
      <div class="field full hidden" id="fullWrap"><div class="subhead" style="margin-top:0">Дополнительно (Full)</div><div class="score-grid">${fullRows}</div></div>

      <div class="modal-foot field full" style="flex-direction:row;justify-content:space-between">
        <div>${item ? `<button type="button" class="btn btn-danger" id="delItem">Удалить</button>` : ''}</div>
        <div style="display:flex;gap:10px">
          <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
          <button type="submit" class="btn btn-primary">Сохранить</button>
        </div>
      </div>
    </form></div>`);

  const costInput = $('#costInput');
  const bandDisplay = $('#bandDisplay');
  const catSelect = $('#catSelect');
  const layerSelect = $('#layerSelect');
  const scoreTypeSel = $('#scoreType');
  let layerTouched = !!(item && (item.layer || item.bucket)); // слой следует за категорией, пока его не трогали
  if (!layerTouched) { const c0 = catObj(catSelect.value); if (c0) layerSelect.value = c0.layer; }

  function collectScores() {
    const s = {};
    $$('.score-input').forEach((el) => { s[el.dataset.id] = +el.value; });
    return s;
  }
  function refreshBand() {
    const band = clientBand(costInput.value);
    bandDisplay.value = bandLabel(band);
    const rec = (band === 'large' || band === 'major') ? 'Full' : (band === 'medium' ? 'Quick' : '—');
    $('#scoreHint').textContent = rec === '—' ? 'Для мелких покупок оценка не нужна.' : `Рекомендуется: ${rec}.`;
  }
  function refreshVerdict() {
    const v = clientVerdict(scoreTypeSel.value, collectScores());
    const banner = $('#verdictBanner');
    if (!v) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    const col = v.verdict === 'keep' ? 'var(--green)' : v.verdict === 'drop' ? 'var(--red)' : 'var(--amber)';
    banner.innerHTML = `<div class="verdict-banner" style="background:color-mix(in srgb, ${col} 14%, transparent);color:${col}">
      <span>Вердикт: ${VERDICT_LABELS[v.verdict]}</span><span>${v.score}/100</span></div>`;
  }
  function refreshScoreSections() {
    const t = scoreTypeSel.value;
    $('#quickWrap').classList.toggle('hidden', t === 'none');
    $('#fullWrap').classList.toggle('hidden', t !== 'full');
    refreshVerdict();
  }

  costInput.addEventListener('input', refreshBand);
  catSelect.addEventListener('change', () => {
    if (!layerTouched) {
      const c = catObj(catSelect.value);
      if (c) layerSelect.value = c.layer;
    }
  });
  layerSelect.addEventListener('change', () => { layerTouched = true; });
  scoreTypeSel.addEventListener('change', refreshScoreSections);
  $$('.score-input').forEach((el) => el.addEventListener('input', (e) => {
    e.target.nextElementSibling.textContent = e.target.value; refreshVerdict();
  }));
  refreshBand();
  refreshScoreSections();

  $('#itemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const scoreType = f.get('scoreType');
    const payload = {
      title: f.get('title'), cost: +f.get('cost'), category: f.get('category'), layer: f.get('layer'), type: f.get('type'),
      priority: +f.get('priority'), emotional: +f.get('emotional'), trajectory: +f.get('trajectory'),
      deadline: f.get('deadline') || null, earliestDate: f.get('earliestDate') || null,
      canDefer: f.get('canDefer') === 'on', notes: f.get('notes'),
      scoreType, scores: scoreType === 'none' ? null : collectScores(),
    };
    if (item) await api.put(`/api/items/${item.id}`, payload);
    else await api.post('/api/items', payload);
    closeModal(); toast('Сохранено'); await refresh();
  });
  if (item) $('#delItem')?.addEventListener('click', async () => {
    if (!confirm('Удалить желание навсегда?')) return;
    await api.del(`/api/items/${item.id}`); closeModal(); toast('Удалено'); await refresh();
  });
}

// ---------- util ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

bootstrap().catch((e) => console.error(e));
