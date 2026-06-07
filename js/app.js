/* ============================================================
   垃圾回收輪值排班系統 — P0+ (localStorage, 多館別)
   多館別 / 每館注意事項 / 自動排班 / 月曆拖拉 / 3:4 PNG 匯出
   週起點 = 星期一；倒垃圾日僅顯示
   ============================================================ */

const STORE_KEY = 'garbage-scheduler-v1';
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']; // 0=Mon .. 6=Sun
const WEEKDAY_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BUILDING_NAMES = ['古亭1館', '古亭2館', '師大館', '中山館', '信義館'];

/* ---------- 預設資料（5 個空白館別） ---------- */
function defaultState() {
  const buildings = BUILDING_NAMES.map((name, i) => ({
    id: 'b' + (i + 1),
    name,
    dutyWeekdays: [],   // 由小幫手自填
    groups: [],         // 清空 MOCK，留白
    rulesHtml: '',      // 規則說明（左欄，富文本）
    otherHtml: '',      // 其他注意事項（右欄，富文本）
  }));
  return {
    buildings,
    currentBuildingId: buildings[0].id,
    schedules: {},      // "b1|2026-06": { weeks: [{ groupId, locked }] }
    view: { year: 2026, month: 6 },
  };
}

let _seq = 0;
function gid() {
  _seq += 1;
  return 'g' + Date.now().toString(36) + '_' + _seq;
}

/* ---------- 狀態存取 ---------- */
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return defaultState();
}
function migrate(s) {
  const def = defaultState();
  if (!Array.isArray(s.buildings) || !s.buildings.length) s.buildings = def.buildings;
  s.buildings.forEach(b => {
    b.dutyWeekdays = b.dutyWeekdays || [];
    b.groups = b.groups || [];
    // 舊版單一 notes（純文字）→ 併入左欄規則說明
    if (b.rulesHtml === undefined) {
      b.rulesHtml = b.notes ? escapeHtml(b.notes).replace(/\n/g, '<br>') : '';
    }
    if (b.otherHtml === undefined) b.otherHtml = '';
    delete b.notes;
  });
  if (!s.currentBuildingId || !s.buildings.some(b => b.id === s.currentBuildingId)) {
    s.currentBuildingId = s.buildings[0].id;
  }
  s.schedules = s.schedules || {};
  s.view = s.view || def.view;
  return s;
}
function saveLocal() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}
function save() {
  saveLocal();
  if (window.Cloud && Cloud.enabled) Cloud.push(state);
}

/* ---------- 目前館別 ---------- */
function curBuilding() {
  return state.buildings.find(b => b.id === state.currentBuildingId) || state.buildings[0];
}

/* ============================================================
   排班核心：週列計算（週一起算）+ round-robin
   ============================================================ */
function computeWeeks(year, month) {
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = (first.getDay() + 6) % 7; // 0=Mon..6=Sun
  const totalCells = firstDow + daysInMonth;
  const rowCount = Math.ceil(totalCells / 7);

  const weeks = [];
  for (let r = 0; r < rowCount; r++) {
    const days = [];
    for (let c = 0; c < 7; c++) {
      const cellIndex = r * 7 + c;
      const dayNum = cellIndex - firstDow + 1;
      const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
      let showDay = dayNum;
      if (dayNum < 1) {
        const prevDays = new Date(year, month - 1, 0).getDate();
        showDay = prevDays + dayNum;
      } else if (dayNum > daysInMonth) {
        showDay = dayNum - daysInMonth;
      }
      days.push({ day: showDay, inMonth, dow: c });
    }
    weeks.push({ weekIndex: r + 1, days });
  }
  return weeks;
}

function schedKey(buildingId, year, month) {
  return buildingId + '|' + year + '-' + String(month).padStart(2, '0');
}

// 取得（必要時生成）目前館別該月排班；保留 locked 的指派
function getSchedule(year, month) {
  const b = curBuilding();
  const key = schedKey(b.id, year, month);
  const weeks = computeWeeks(year, month);
  const groups = b.groups;
  let sched = state.schedules[key] || { weeks: [] };

  const out = [];
  let auto = computeStartOffset(year, month);
  for (let i = 0; i < weeks.length; i++) {
    const prev = sched.weeks[i];
    if (prev && prev.locked && groups.some(gr => gr.id === prev.groupId)) {
      out.push({ groupId: prev.groupId, locked: true });
    } else {
      const gidv = groups.length ? groups[auto % groups.length].id : null;
      out.push({ groupId: gidv, locked: false });
      auto++;
    }
  }
  sched.weeks = out;
  state.schedules[key] = sched;
  return sched;
}

// 跨月延續：累加同年此月之前的週列數當起始順位
function computeStartOffset(year, month) {
  let offset = 0;
  let y = year, m = 1;
  while (!(y === year && m === month)) {
    offset += computeWeeks(y, m).length;
    m++;
    if (m > 12) { m = 1; y++; }
    if ((y - year) > 2) break;
  }
  return offset;
}

function reAutoSchedule(year, month) {
  const key = schedKey(curBuilding().id, year, month);
  delete state.schedules[key];
  getSchedule(year, month);
  save();
}

/* ============================================================
   渲染
   ============================================================ */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function groupName(id) {
  const gr = curBuilding().groups.find(x => x.id === id);
  return gr ? gr.name : '（未指派）';
}

function dutyDayText() {
  const d = curBuilding().dutyWeekdays.slice().sort((a, b) => a - b);
  return d.length ? '每週 ' + d.map(i => WEEKDAY_LABELS[i]).join('、') : '尚未設定';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 館別標籤 ---------- */
function renderTabs() {
  const wrap = $('#buildingTabs');
  wrap.innerHTML = '';
  state.buildings.forEach(b => {
    const chip = document.createElement('button');
    chip.className = 'bt-chip' + (b.id === state.currentBuildingId ? ' on' : '');
    chip.textContent = b.name;
    chip.addEventListener('click', () => {
      state.currentBuildingId = b.id;
      save();
      rerender();
    });
    wrap.appendChild(chip);
  });
}

function renderHeader() {
  $('#monthLabel').textContent = state.view.year + ' 年 ' + state.view.month + ' 月';
}

function renderThisWeek() {
  const { year, month } = state.view;
  const sched = getSchedule(year, month);
  const now = new Date();
  let idx = 0;
  if (now.getFullYear() === year && now.getMonth() + 1 === month) {
    idx = currentWeekIndex(year, month, now.getDate());
  }
  const wk = sched.weeks[idx];
  $('#thisWeekName').textContent = wk ? groupName(wk.groupId) : '—';
  $('#thisWeekSub').textContent = '倒垃圾日：' + dutyDayText();
  return idx;
}

function currentWeekIndex(year, month, dayNum) {
  const weeks = computeWeeks(year, month);
  for (let i = 0; i < weeks.length; i++) {
    if (weeks[i].days.some(d => d.inMonth && d.day === dayNum)) return i;
  }
  return 0;
}

function renderBoard() {
  const { year, month } = state.view;
  const weeks = computeWeeks(year, month);
  const sched = getSchedule(year, month);
  const duty = curBuilding().dutyWeekdays;
  const list = $('#weekList');

  // 左欄：可拖拉的分組名牌；右欄：固定的週次+日期
  const chips = weeks.map((wk, i) => {
    const assign = sched.weeks[i] || {};
    return `<div class="wk-name ${assign.locked ? 'locked' : ''}" data-index="${i}" data-gid="${assign.groupId || ''}">
        <span class="wk-group">${escapeHtml(groupName(assign.groupId))}</span>
      </div>`;
  }).join('');

  const calRows = weeks.map((wk) => {
    const daysHtml = wk.days.map(d => {
      const cls = ['wk-day'];
      if (!d.inMonth) cls.push('out');
      if (d.dow >= 5) cls.push('weekend');
      if (d.inMonth && duty.includes(d.dow)) cls.push('duty');
      return `<div class="${cls.join(' ')}"><span class="dow">${WEEKDAY_LABELS[d.dow]}</span>${d.day}</div>`;
    }).join('');
    return `<div class="cal-row">
        <span class="cal-badge">W${wk.weekIndex}</span>
        <div class="wk-days">${daysHtml}</div>
      </div>`;
  }).join('');

  list.innerHTML = `
    <div class="board-grid">
      <div class="col-names" id="wkNames">${chips}</div>
      <div class="col-cal">${calRows}</div>
    </div>`;

  $$('#wkNames .wk-name').forEach(el => {
    el.addEventListener('click', () => openPicker(parseInt(el.dataset.index, 10)));
  });

  initSortable();
}

function renderNotes() {
  const b = curBuilding();
  setNoteSection($('#rulesView'), b.rulesHtml);
  setNoteSection($('#otherView'), b.otherHtml);
}
function setNoteSection(el, html) {
  if (html && html.replace(/<[^>]*>/g, '').trim()) {
    el.innerHTML = html;
    el.classList.remove('empty');
  } else {
    el.innerHTML = '尚未填寫，點上方「編輯」填入。';
    el.classList.add('empty');
  }
}

/* ---------- 富文本（粗體 / 顏色） ---------- */
const RT_ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'SPAN', 'FONT', 'BR', 'DIV', 'P']);
function sanitizeHtml(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const walk = (node) => {
    Array.from(node.childNodes).forEach(ch => {
      if (ch.nodeType === 1) {
        if (!RT_ALLOWED.has(ch.tagName)) {
          const p = ch.parentNode;
          while (ch.firstChild) p.insertBefore(ch.firstChild, ch);
          p.removeChild(ch);
        } else {
          Array.from(ch.attributes).forEach(a => {
            const n = a.name.toLowerCase();
            if (n === 'color') return;                 // <font color>
            if (n === 'style') {
              const c = ch.style.color;
              ch.removeAttribute('style');
              if (c) ch.style.color = c;               // 只留文字顏色
              return;
            }
            ch.removeAttribute(a.name);
          });
          walk(ch);
        }
      } else if (ch.nodeType !== 3) {
        ch.remove();
      }
    });
  };
  walk(root); walk(root); // 第二輪清理被 unwrap 出來的子節點
  return root.innerHTML;
}

function setupRichToolbars() {
  $$('.rt-toolbar').forEach(tb => {
    const target = document.getElementById(tb.dataset.for);
    if (!target) return;
    tb.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault()); // 保留選取範圍
      btn.addEventListener('click', () => {
        target.focus();
        if (btn.dataset.cmd === 'bold') document.execCommand('bold');
        else if (btn.dataset.cmd === 'color') document.execCommand('foreColor', false, btn.dataset.color);
      });
    });
  });
}

/* ---------- 行數上限（避免匯出圖超出範圍） ---------- */
function rtLines(area) {
  const t = (area.innerText || '').replace(/​/g, '').replace(/\n+$/g, '');
  return t ? t.split('\n').length : 0;
}
function updateRichCount(area) {
  const max = parseInt(area.dataset.maxlines, 10);
  const c = document.querySelector('.rt-count[data-for="' + area.id + '"]');
  if (!c) return;
  const n = rtLines(area);
  c.textContent = '行 ' + n + ' / ' + max;
  c.classList.toggle('over', n >= max);
}
function setupRichLimits() {
  $$('.rt-area[data-maxlines]').forEach(area => {
    const max = parseInt(area.dataset.maxlines, 10);
    area.addEventListener('beforeinput', (e) => {
      const t = e.inputType || '';
      const cur = rtLines(area);
      if (t === 'insertParagraph' || t === 'insertLineBreak') {
        if (cur >= max) e.preventDefault();
        return;
      }
      if (t === 'insertFromPaste' && e.dataTransfer) {
        const paste = e.dataTransfer.getData('text') || '';
        const addLines = (paste.match(/\n/g) || []).length;
        if (cur + addLines > max) e.preventDefault();
      }
    });
    area.addEventListener('input', () => updateRichCount(area));
  });
}

/* ---------- 拖拉排序 ---------- */
let sortable;
function initSortable() {
  const names = $('#wkNames');
  if (!names) return;
  if (sortable) sortable.destroy();
  sortable = Sortable.create(names, {
    animation: 160,
    delay: 120,
    delayOnTouchOnly: true,
    onEnd: (evt) => {
      if (evt.oldIndex === evt.newIndex) return;
      applyChipOrder();
    },
  });
}

// 依名牌目前的 DOM 順序，重新指派每週的分組（日期欄不動）
function applyChipOrder() {
  const { year, month } = state.view;
  const sched = getSchedule(year, month);
  const chips = $$('#wkNames .wk-name');
  chips.forEach((chip, pos) => {
    if (!sched.weeks[pos]) return;
    sched.weeks[pos].groupId = chip.dataset.gid || null;
    sched.weeks[pos].locked = true;
  });
  save();
  rerender();
  toast('已調整分組');
}

/* ============================================================
   換組 picker
   ============================================================ */
function openPicker(index) {
  const groups = curBuilding().groups;
  const listEl = $('#pickerList');
  listEl.innerHTML = '';
  if (!groups.length) {
    listEl.innerHTML = '<div class="picker-empty">此館還沒有輪值組，請先到 ⚙️ 設定新增。</div>';
    openSheet($('#pickerSheet'));
    return;
  }
  groups.forEach(gr => {
    const item = document.createElement('div');
    item.className = 'picker-item';
    item.textContent = gr.name;
    item.addEventListener('click', () => {
      const { year, month } = state.view;
      const sched = getSchedule(year, month);
      sched.weeks[index].groupId = gr.id;
      sched.weeks[index].locked = true;
      save();
      closeSheet($('#pickerSheet'));
      rerender();
      toast('已換組');
    });
    listEl.appendChild(item);
  });
  openSheet($('#pickerSheet'));
}

/* ============================================================
   館別設定
   ============================================================ */
function openSettings() {
  const b = curBuilding();
  $('#settingsTitle').textContent = b.name + ' · 設定';
  $('#setName').value = b.name;
  $('#editRules').innerHTML = b.rulesHtml || '';
  $('#editOther').innerHTML = b.otherHtml || '';
  updateRichCount($('#editRules'));
  updateRichCount($('#editOther'));
  renderWeekdayPicker();
  renderGroupEditor();
  openSheet($('#settingsSheet'));
}

function renderWeekdayPicker() {
  const wrap = $('#weekdayPicker');
  wrap.innerHTML = '';
  const duty = curBuilding().dutyWeekdays;
  WEEKDAY_LABELS.forEach((lab, i) => {
    const chip = document.createElement('div');
    chip.className = 'wd-chip' + (duty.includes(i) ? ' on' : '');
    chip.textContent = lab;
    chip.dataset.dow = i;
    chip.addEventListener('click', () => chip.classList.toggle('on'));
    wrap.appendChild(chip);
  });
}

let groupSortable;
function renderGroupEditor() {
  const wrap = $('#groupEditor');
  wrap.innerHTML = '';
  curBuilding().groups.forEach(gr => addGroupRow(gr.id, gr.name));
  if (groupSortable) groupSortable.destroy();
  groupSortable = Sortable.create(wrap, { handle: '.drag', animation: 150 });
}

function addGroupRow(id, name) {
  const wrap = $('#groupEditor');
  const row = document.createElement('div');
  row.className = 'group-row';
  row.dataset.id = id || gid();
  row.innerHTML = `
    <span class="drag">⠿</span>
    <input type="text" value="${escapeHtml(name || '')}" placeholder="例：R1-A" />
    <button class="del" title="刪除">✕</button>`;
  row.querySelector('.del').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
  if (!name) row.querySelector('input').focus();
}

function saveSettings() {
  const b = curBuilding();
  b.name = $('#setName').value.trim() || b.name;
  b.rulesHtml = sanitizeHtml($('#editRules').innerHTML);
  b.otherHtml = sanitizeHtml($('#editOther').innerHTML);
  b.dutyWeekdays = $$('#weekdayPicker .wd-chip.on')
    .map(c => parseInt(c.dataset.dow, 10)).sort((a, b2) => a - b2);

  const groups = [];
  $$('#groupEditor .group-row').forEach(r => {
    const name = r.querySelector('input').value.trim();
    if (name) groups.push({ id: r.dataset.id, name });
  });
  b.groups = groups; // 允許空白

  save();
  closeSheet($('#settingsSheet'));
  rerender();
  toast('設定已儲存');
}

/* ============================================================
   匯出 3:4 PNG
   ============================================================ */
function buildPosterDOM() {
  const b = curBuilding();
  const { year, month } = state.view;
  const weeks = computeWeeks(year, month);
  const sched = getSchedule(year, month);
  const duty = b.dutyWeekdays;

  const mm = String(month).padStart(2, '0');
  const headRow = `<tr>
      <th class="mlabel">輪值組</th>
      ${WEEKDAY_EN.map((d, i) => duty.includes(i)
        ? `<th class="wd-duty"><span>${d}</span></th>`
        : `<th>${d}</th>`).join('')}
    </tr>`;

  const bodyRows = weeks.map((wk, i) => {
    const assign = sched.weeks[i] || {};
    const name = groupName(assign.groupId);
    const isNone = !assign.groupId;
    const cells = wk.days.map(d => {
      const cls = ['p-day'];
      const dutyOn = d.inMonth && duty.includes(d.dow);
      if (!d.inMonth) cls.push('out');
      if (dutyOn) cls.push('duty');
      return `<td class="${cls.join(' ')}">${dutyOn ? `<span>${d.day}</span>` : d.day}</td>`;
    }).join('');
    return `<tr>
        <td class="p-name-cell">
          <div class="p-name-wrap">
            <span class="p-badge">W${wk.weekIndex}</span>
            <span class="p-group ${isNone ? 'none' : ''}">${escapeHtml(name)}</span>
          </div>
        </td>
        ${cells}
      </tr>`;
  }).join('');

  const hasText = (h) => h && h.replace(/<[^>]*>/g, '').trim();
  const rulesHtml = hasText(b.rulesHtml) ? b.rulesHtml : '<span style="color:#b6ada4">—</span>';
  const otherHtml = hasText(b.otherHtml) ? b.otherHtml : '<span style="color:#b6ada4">有事請與室友交換班；若無人可換，可付費請室友或小幫手代倒。</span>';

  return `
    <div class="poster">
      <div class="p-top">
        <div class="p-head">
          <div class="p-head-l">
            <div class="p-title">垃圾輪值表</div>
            <div class="p-kicker">Recycling &amp; Trash Duty</div>
          </div>
          <div class="p-head-r">
            <div class="p-bchip">${escapeHtml(b.name)}</div>
            <div class="p-period"><span class="pp-dot"></span>${year}.${mm}</div>
          </div>
        </div>
      </div>

      <div class="p-card">
        <table class="p-grid">
          <colgroup><col class="c-name" /><col /><col /><col /><col /><col /><col /><col /></colgroup>
          <thead>${headRow}</thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>

      <div class="p-notes">
        <div class="p-note-col rules">
          <div class="p-note-title">規則說明</div>
          <div class="p-note-body">${rulesHtml}</div>
        </div>
        <div class="p-note-col other">
          <div class="p-note-title">其他注意事項</div>
          <div class="p-note-body">${otherHtml}</div>
        </div>
      </div>

      <div class="p-foot">
        <span class="pf-tag">請依輪值表確實執行，謝謝配合 🙏</span>
        <img class="pf-logo" src="${window.LOGO_URI || 'assets/logo.png'}" alt="聚空間" />
      </div>
    </div>`;
}

async function exportPoster() {
  const stage = $('#exportStage');
  stage.innerHTML = buildPosterDOM();
  toast('產生圖片中…', 4000);
  const node = stage.querySelector('.poster');
  try {
    const canvas = await html2canvas(node, { scale: 1, backgroundColor: '#f7f3ee', useCORS: true });
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${curBuilding().name}_${state.view.year}-${String(state.view.month).padStart(2, '0')}_輪值表.png`;
    a.click();
    toast('已下載圖片 ✅');
  } catch (e) {
    console.error(e);
    toast('匯出失敗：' + e.message, 4000);
  } finally {
    stage.innerHTML = '';
  }
}

/* ============================================================
   UI 工具
   ============================================================ */
function openSheet(sheet) { sheet.classList.remove('hidden'); }
function closeSheet(sheet) { sheet.classList.add('hidden'); }

let toastTimer;
function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function rerender() {
  renderTabs();
  renderHeader();
  renderThisWeek();
  renderBoard();
  renderNotes();
}

/* ============================================================
   事件綁定
   ============================================================ */
function shiftMonth(delta) {
  let { year, month } = state.view;
  month += delta;
  if (month < 1) { month = 12; year--; }
  if (month > 12) { month = 1; year++; }
  state.view = { year, month };
  save();
  rerender();
}

function bind() {
  $('#prevMonth').addEventListener('click', () => shiftMonth(-1));
  $('#nextMonth').addEventListener('click', () => shiftMonth(1));
  $('#btnAuto').addEventListener('click', () => {
    if (confirm('重新自動排班會清除本月手動調整，確定嗎？')) {
      reAutoSchedule(state.view.year, state.view.month);
      rerender();
      toast('已重新排班');
    }
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnEditNotes').addEventListener('click', openSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnAddGroup').addEventListener('click', () => addGroupRow());
  $('#btnExportMonth').addEventListener('click', () => exportPoster());

  $$('[data-close]').forEach(el => {
    el.addEventListener('click', () => closeSheet(el.closest('.sheet')));
  });

  setupRichToolbars();
  setupRichLimits();
}

/* ============================================================
   雲端同步（免登入；整包 state 存單一雲端列）
   ============================================================ */
let _cloudStamp = '';

function setupCloudStatus() {
  if (!window.Cloud || !Cloud.enabled) return;
  const el = document.createElement('span');
  el.id = 'cloudStatus';
  el.textContent = '☁️';
  el.title = '雲端同步已開啟';
  el.style.cssText = 'font-size:14px;margin-left:6px;opacity:.65;transition:opacity .2s;';
  const host = $('.topbar-title');
  if (host) host.appendChild(el);
  window.addEventListener('cloud:saved', () => { el.textContent = '☁️'; el.title = '已同步雲端'; el.style.opacity = '.65'; });
  window.addEventListener('cloud:error', () => { el.textContent = '⚠️'; el.title = '雲端同步失敗（資料仍在本機）'; el.style.opacity = '1'; });
}

async function initCloud() {
  if (!window.Cloud || !Cloud.enabled) return;
  setupCloudStatus();
  try {
    const row = await Cloud.pull();
    _cloudStamp = (row && row.updated_at) || '';
    const hasCloud = row && row.data && Object.keys(row.data).length > 0;
    if (hasCloud) {
      state = migrate(row.data);
      saveLocal();
      rerender();
      toast('已從雲端載入 ☁️');
    } else {
      Cloud.push(state); // 雲端尚空 → 用本機資料當第一版
    }
  } catch (e) {
    console.warn('[cloud] 初始化失敗，使用本機資料', e);
    toast('雲端連線失敗，先用本機資料');
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFromCloud();
  });
}

async function refreshFromCloud() {
  if (!window.Cloud || !Cloud.enabled) return;
  try {
    await Cloud.flush();            // 先把本機未上傳的變更推上去
    const row = await Cloud.pull();
    if (row && row.updated_at && row.updated_at !== _cloudStamp) {
      _cloudStamp = row.updated_at;
      if (row.data && Object.keys(row.data).length) {
        state = migrate(row.data);
        saveLocal();
        rerender();
      }
    }
  } catch (e) { /* 靜默：維持本機 */ }
}

/* ---------- 啟動 ---------- */
bind();
rerender();
initCloud();
