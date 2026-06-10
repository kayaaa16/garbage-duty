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
    mode: 'week',       // 排班方式：'week' 週輪替（一週一組）｜ 'day' 每日安排（逐日指定）
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
    b.mode = (b.mode === 'day') ? 'day' : 'week';
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

  // 對齊週數、保留既有指派（手動拖拉 & 重排結果都會留著，不會每次被重算覆蓋）
  const out = [];
  for (let i = 0; i < weeks.length; i++) {
    out.push(sched.weeks[i] || { groupId: null, locked: false });
  }
  // 只補「未鎖定且尚未指派 / 指派的組已被刪」的週，用預設順序 round-robin
  let auto = computeStartOffset(year, month);
  out.forEach(w => {
    const valid = w.groupId && groups.some(g => g.id === w.groupId);
    if (!w.locked && !valid) {
      w.groupId = groups.length ? groups[auto % groups.length].id : null;
      auto++;
    }
  });
  sched.weeks = out;
  state.schedules[key] = sched;
  return sched;
}

// 起始順位：若該館「上一個月」已排程則接續其最後一組之後；否則從第 1 組開始
function computeStartOffset(year, month) {
  const b = curBuilding();
  if (!b.groups.length) return 0;
  let py = year, pm = month - 1;
  if (pm < 1) { pm = 12; py--; }
  const prev = state.schedules[schedKey(b.id, py, pm)];
  if (prev && prev.weeks && prev.weeks.length) {
    const lastGid = prev.weeks[prev.weeks.length - 1].groupId;
    const idx = b.groups.findIndex(g => g.id === lastGid);
    if (idx >= 0) return idx + 1;   // 接續上月最後一組的下一組
  }
  return 0;                          // 第一個月 → 從第 1 組開始
}

/* ---------- 每日安排模式（mode: 'day'） ---------- */
// 該月所有「倒垃圾日期」(day-of-month)，依時間排序
function dutyDates(year, month) {
  const duty = curBuilding().dutyWeekdays;
  const daysInMonth = new Date(year, month, 0).getDate();
  const out = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = (new Date(year, month - 1, d).getDay() + 6) % 7; // 0=Mon..6=Sun
    if (duty.includes(dow)) out.push({ day: d, dow });
  }
  return out;
}

// 每日模式：起始順位接續上一個月最後一個倒垃圾日的下一組
function computeStartOffsetDay(year, month) {
  const b = curBuilding();
  if (!b.groups.length) return 0;
  let py = year, pm = month - 1;
  if (pm < 1) { pm = 12; py--; }
  const prev = state.schedules[schedKey(b.id, py, pm)];
  if (prev && prev.days) {
    const pdates = dutyDates(py, pm);
    for (let i = pdates.length - 1; i >= 0; i--) {
      const g = prev.days[pdates[i].day];
      const idx = b.groups.findIndex(x => x.id === g);
      if (idx >= 0) return idx + 1;
    }
  }
  return 0;
}

// 取得（必要時生成）每日指派：{ dayNum: groupId }；保留手動指定、只補空/失效、清掉非倒垃圾日
function getDaySchedule(year, month) {
  const b = curBuilding();
  const key = schedKey(b.id, year, month);
  const groups = b.groups;
  const dates = dutyDates(year, month);
  const sched = state.schedules[key] || {};
  const days = sched.days || {};
  const start = computeStartOffsetDay(year, month);
  dates.forEach((dt, idx) => {
    const cur = days[dt.day];
    const valid = cur && groups.some(g => g.id === cur);
    if (!valid) days[dt.day] = groups.length ? groups[(start + idx) % groups.length].id : null;
  });
  // 倒垃圾星期被改過 → 清掉已不是倒垃圾日的舊指派
  Object.keys(days).forEach(k => { if (!dates.some(dt => dt.day === +k)) delete days[k]; });
  sched.days = days;
  state.schedules[key] = sched;
  return days;
}

// 每日模式隨機重排：洗牌組別順序後逐日 round-robin
function reAutoScheduleDay(year, month) {
  const b = curBuilding();
  const key = schedKey(b.id, year, month);
  const groups = b.groups;
  const dates = dutyDates(year, month);
  const sched = state.schedules[key] || {};
  if (!groups.length) { sched.days = {}; state.schedules[key] = sched; save(); return; }
  const before = dates.map(dt => (sched.days || {})[dt.day]).join(',');
  let order, seq, tries = 0;
  do {
    order = groups.map(g => g.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    seq = dates.map((dt, i) => order[i % order.length]).join(',');
    tries++;
  } while (seq === before && tries < 8 && groups.length > 1);
  const days = {};
  dates.forEach((dt, i) => { days[dt.day] = order[i % order.length]; });
  sched.days = days;
  state.schedules[key] = sched;
  save();
}

// 依目前館別模式分派隨機重排
function reAutoScheduleAny(year, month) {
  if (curBuilding().mode === 'day') reAutoScheduleDay(year, month);
  else reAutoSchedule(year, month);
}

// 隨機重排：把組別順序洗牌後 round-robin 填滿（清除手動鎖定），每次盡量不同
function reAutoSchedule(year, month) {
  const b = curBuilding();
  const key = schedKey(b.id, year, month);
  const weeks = computeWeeks(year, month);
  const groups = b.groups;
  if (!groups.length) {
    state.schedules[key] = { weeks: weeks.map(() => ({ groupId: null, locked: false })) };
    save();
    return;
  }
  const before = (state.schedules[key] && state.schedules[key].weeks || []).map(w => w.groupId).join(',');
  let order, seq, tries = 0;
  do {
    order = groups.map(g => g.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    seq = weeks.map((wk, i) => order[i % order.length]).join(',');
    tries++;
  } while (seq === before && tries < 8 && groups.length > 1);
  state.schedules[key] = { weeks: weeks.map((wk, i) => ({ groupId: order[i % order.length], locked: false })) };
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
  // 「本週輪值」永遠跟著今天的真實日期，不隨上方檢視月份切換而改變
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = now.getDate();
  const wd = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const tag = $('#thisWeekCard .tw-tag');
  if (tag) tag.textContent = `本週輪值 · 依今天 ${month}/${today}（週${wd}）`;

  // 每日安排模式：顯示「今天 / 下一個倒垃圾日」由哪一組負責
  if (curBuilding().mode === 'day') {
    const days = getDaySchedule(year, month);
    const dates = dutyDates(year, month);
    const todayDuty = dates.find(dt => dt.day === today);
    const next = dates.find(dt => dt.day >= today);
    if (todayDuty) {
      $('#thisWeekName').textContent = groupName(days[today]);
      $('#thisWeekSub').textContent = '今天輪到囉，記得倒垃圾 🗑️';
    } else if (next) {
      $('#thisWeekName').textContent = groupName(days[next.day]);
      $('#thisWeekSub').textContent = `下次 ${month}/${next.day}（週${WEEKDAY_LABELS[next.dow]}）`;
    } else {
      $('#thisWeekName').textContent = '—';
      $('#thisWeekSub').textContent = '本月已無倒垃圾日';
    }
    return;
  }

  // 週輪替模式
  const sched = getSchedule(year, month);
  const idx = currentWeekIndex(year, month, today);
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
  const hint = $('#boardHint');
  if (curBuilding().mode === 'day') {
    if (hint) hint.textContent = '點日曆上的橘色格子，可指定那天由哪一組負責';
    return renderBoardDay();
  }
  if (hint) hint.textContent = '長按左側名牌可拖拉調整週次；點名牌可換組';

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

// 每日安排模式的編輯畫面：整月日曆，點橘色倒垃圾日逐日指定負責組
function renderBoardDay() {
  const { year, month } = state.view;
  const b = curBuilding();
  const weeks = computeWeeks(year, month);
  const days = getDaySchedule(year, month);
  const duty = b.dutyWeekdays;
  const list = $('#weekList');

  const calRows = weeks.map(wk => {
    const daysHtml = wk.days.map(d => {
      const cls = ['wk-day'];
      if (!d.inMonth) cls.push('out');
      if (d.dow >= 5) cls.push('weekend');
      const isDuty = d.inMonth && duty.includes(d.dow);
      if (isDuty) cls.push('duty');
      const assign = isDuty
        ? `<span class="day-assign">${escapeHtml(groupName(days[d.day]))}</span>`
        : '';
      const attr = isDuty ? ` data-day="${d.day}"` : '';
      return `<div class="${cls.join(' ')}"${attr}><span class="dow">${WEEKDAY_LABELS[d.dow]}</span>${d.day}${assign}</div>`;
    }).join('');
    return `<div class="cal-row"><span class="cal-badge">W${wk.weekIndex}</span><div class="wk-days">${daysHtml}</div></div>`;
  }).join('');

  list.innerHTML = `<div class="day-board">${calRows}</div>`;
  $$('#weekList .wk-day.duty[data-day]').forEach(el => {
    el.addEventListener('click', () => openPickerDay(parseInt(el.dataset.day, 10)));
  });
}

// 每日模式：點某一天 → 指定那天的負責組
function openPickerDay(dayNum) {
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
      const key = schedKey(curBuilding().id, year, month);
      const sched = state.schedules[key] || (state.schedules[key] = {});
      sched.days = sched.days || {};
      sched.days[dayNum] = gr.id;
      save();
      closeSheet($('#pickerSheet'));
      rerender();
      toast('已指定 ' + state.view.month + '/' + dayNum);
    });
    listEl.appendChild(item);
  });
  openSheet($('#pickerSheet'));
}

// 規則/注意事項：用跟匯出圖完全相同的兩欄版型，等比例縮放成「所見即所得」預覽
const POSTER_NOTES_W = 952; // 匯出海報 notes 區寬度（1080 − 64×2）
function renderNotes() {
  const b = curBuilding();
  const host = $('#notesPreview');
  if (!host) return;
  const fb = (h, ph) => (h && h.replace(/<[^>]*>/g, '').trim()) ? h : `<span class="np-empty">${ph}</span>`;
  // 量測「目前檢視月份」海報上兩欄正文的可用高度，預覽用同樣固定高度 → 真．所見即所得
  const avail = posterNoteAvail();
  const hStyle = (px) => px ? `height:${px}px;flex:none;` : '';
  host.innerHTML = `
    <div class="np-scaler"><div class="p-notes np-board">
      <div class="p-note-col rules"><div class="p-note-title">規則說明</div><div class="p-note-body" style="${hStyle(avail.rules)}">${fb(b.rulesHtml, '（尚未填寫，點右上「編輯」）')}</div></div>
      <div class="p-note-col other"><div class="p-note-title">其他注意事項</div><div class="p-note-body" style="${hStyle(avail.other)}">${fb(b.otherHtml, '（尚未填寫，點右上「編輯」）')}</div></div>
    </div></div>`;
  autoFitNoteBodies(host);   // 字太多時自動縮字塞滿固定高度（跟匯出一致）
  fitNotesPreview();
  setTimeout(() => { autoFitNoteBodies(host); fitNotesPreview(); }, 150); // 等字體載入後再校正
}
function fitNotesPreview() {
  const host = $('#notesPreview');
  if (!host) return;
  const scaler = host.querySelector('.np-scaler');
  const board = host.querySelector('.np-board');
  if (!board || !host.clientWidth) return;
  board.style.width = POSTER_NOTES_W + 'px';
  board.style.transformOrigin = 'top left';
  const scale = host.clientWidth / POSTER_NOTES_W;
  board.style.transform = 'scale(' + scale + ')';
  scaler.style.height = (board.offsetHeight * scale) + 'px';
}

// 量測目前檢視月份海報上「規則 / 其他」兩欄正文的可用高度（海報原始 px，與內容無關，只看版面）
function posterNoteAvail() {
  const stage = $('#exportStage');
  if (!stage) return { rules: 0, other: 0 };
  stage.innerHTML = buildPosterDOM();
  const bodies = stage.querySelectorAll('.p-note-body');
  const avail = {
    rules: bodies[0] ? bodies[0].clientHeight : 0,
    other: bodies[1] ? bodies[1].clientHeight : 0,
  };
  stage.innerHTML = '';
  return avail;
}

// 自動縮字：每欄正文若內容超出固定高度，就把字級往下調到剛好塞得下（下限 9px）
function autoFitNoteBodies(scope) {
  scope.querySelectorAll('.p-note-body').forEach(body => {
    if (!body.clientHeight) return;            // 沒有固定高度就不縮（避免誤縮）
    let fs = 16;
    body.style.fontSize = fs + 'px';
    while (body.scrollHeight > body.clientHeight + 1 && fs > 9) {
      fs -= 0.5;
      body.style.fontSize = fs + 'px';
    }
  });
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
    // 只擋「手動按 Enter 超過行數」；貼上一律放行（避免手機貼不上）
    area.addEventListener('beforeinput', (e) => {
      const t = e.inputType || '';
      if ((t === 'insertParagraph' || t === 'insertLineBreak') && rtLines(area) >= max) {
        e.preventDefault();
      }
    });
    // 貼上：轉純文字插入（手機相容、避免帶入奇怪格式）
    area.addEventListener('paste', (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      const text = cd.getData('text/plain');
      if (text == null) return;
      e.preventDefault();
      try { document.execCommand('insertText', false, text); } catch (_) { /* 失敗就交給預設 */ }
      updateRichCount(area);
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
  renderModePicker();
  renderWeekdayPicker();
  renderGroupEditor();
  openSheet($('#settingsSheet'));
}

function renderModePicker() {
  const wrap = $('#modePicker');
  if (!wrap) return;
  const mode = curBuilding().mode === 'day' ? 'day' : 'week';
  wrap.querySelectorAll('.mode-opt').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.mode === mode);
    opt.onclick = () => {
      wrap.querySelectorAll('.mode-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
    };
  });
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
  const modeOpt = $('#modePicker .mode-opt.active');
  b.mode = (modeOpt && modeOpt.dataset.mode === 'day') ? 'day' : 'week';
  b.rulesHtml = sanitizeHtml($('#editRules').innerHTML);
  b.otherHtml = sanitizeHtml($('#editOther').innerHTML);
  b.dutyWeekdays = $$('#weekdayPicker .wd-chip.on')
    .map(c => parseInt(c.dataset.dow, 10)).sort((a, b2) => a - b2);

  const beforeGroups = b.groups.map(g => g.id).join(',');
  const groups = [];
  $$('#groupEditor .group-row').forEach(r => {
    const name = r.querySelector('input').value.trim();
    if (name) groups.push({ id: r.dataset.id, name });
  });
  b.groups = groups; // 允許空白

  // 輪值組有增刪 → 本月重排成預設順序（讓新增/刪除立即反映；只動本月）
  if (groups.map(g => g.id).join(',') !== beforeGroups) {
    delete state.schedules[schedKey(b.id, state.view.year, state.view.month)];
  }

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
  const isDay = b.mode === 'day';
  const sched = isDay ? null : getSchedule(year, month);
  const days = isDay ? getDaySchedule(year, month) : null;
  const duty = b.dutyWeekdays;

  const mm = String(month).padStart(2, '0');
  // 每日模式不顯示 W 欄 (W1-W5 對排班沒意義，拿掉讓日曆撐滿)
  const headRow = `<tr>
      ${isDay ? '' : '<th class="mlabel">輪值組</th>'}
      ${WEEKDAY_EN.map((d, i) => duty.includes(i)
        ? `<th class="wd-duty"><span>${d}</span></th>`
        : `<th>${d}</th>`).join('')}
    </tr>`;

  const bodyRows = weeks.map((wk, i) => {
    const assign = (sched && sched.weeks[i]) || {};
    const name = groupName(assign.groupId);
    const isNone = !assign.groupId;
    const cells = wk.days.map(d => {
      const cls = ['p-day'];
      const dutyOn = d.inMonth && duty.includes(d.dow);
      if (!d.inMonth) cls.push('out');
      if (dutyOn) cls.push('duty');
      if (isDay) {
        if (dutyOn) {
          cls.push('has-name');
          return `<td class="${cls.join(' ')}"><div class="p-day-in"><span>${d.day}</span><i class="p-day-name">${escapeHtml(groupName(days[d.day]))}</i></div></td>`;
        }
        return `<td class="${cls.join(' ')}">${d.day}</td>`;
      }
      return `<td class="${cls.join(' ')}">${dutyOn ? `<span>${d.day}</span>` : d.day}</td>`;
    }).join('');
    const nameCell = isDay
      ? ''   // 每日模式不出 W 欄
      : `<td class="p-name-cell">
          <div class="p-name-wrap">
            <span class="p-badge">W${wk.weekIndex}</span>
            <span class="p-group ${isNone ? 'none' : ''}">${escapeHtml(name)}</span>
          </div>
        </td>`;
    return `<tr>${nameCell}${cells}</tr>`;
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
          <colgroup>${isDay ? '' : '<col class="c-name" />'}<col /><col /><col /><col /><col /><col /><col /></colgroup>
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
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
    autoFitNoteBodies(node);   // 字多時自動縮字塞滿，保證不被裁切
    // scale:2 → 匯出 2160×2880（原本 scale:1 只有 1080×1440 偏模糊），logo 與文字都更銳利
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: '#f7f3ee', useCORS: true });
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
    if (confirm('隨機重排會打散本月順序並清除手動調整，確定嗎？')) {
      reAutoScheduleAny(state.view.year, state.view.month);
      rerender();
      toast('已隨機重排');
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
  window.addEventListener('resize', fitNotesPreview);
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
