/* 개인 캘린더
 * 기록은 브라우저의 localStorage 에 저장됩니다. (서버로 전송되지 않습니다)
 * 백업은 상단 ⋯ 메뉴의 "JSON 내보내기" 를 사용하세요.
 */
(() => {
  'use strict';

  const KEY = 'cal.diary.v1';
  const SYNC_KEY = 'cal.sync.v1';
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const TAGS = ['', 'important', 'holiday', 'done'];

  // ---------- state ----------
  // days/weeks 의 각 항목은 { text, tag, t } 형태다. t 는 마지막으로 고친 시각(ms)으로,
  // 두 PC 의 기록을 합칠 때 어느 쪽이 최신인지 판단하는 유일한 근거다.
  let store = { version: 2, days: {}, weeks: {}, todos: {} };
  let view = 'month';
  let cursor = new Date();          // 화면에 보이는 기준 날짜
  let selected = null;              // 편집 중인 날짜 (ISO)
  let query = '';

  // ---------- storage ----------

  /* 예전 형식({text,tag} 또는 문자열)도 읽을 수 있게 항상 {text,tag,t} 로 맞춘다.
     예전 기록의 t 는 0 이라 새로 고친 쪽이 항상 이긴다. */
  function normEntry(v) {
    if (typeof v === 'string') return { text: v, tag: '', t: 0 };
    if (!v || typeof v !== 'object' || typeof v.text !== 'string') return null;
    return { text: v.text, tag: v.tag || '', t: Number(v.t) || 0 };
  }

  function normMap(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const e = normEntry(v);
      if (e) out[k] = e;
    }
    return out;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        store.days = normMap(o.days);
        store.weeks = normMap(o.weeks);
        store.todos = normTodos(o.todos);
      }
    } catch (e) {
      console.warn('저장된 기록을 읽지 못했습니다.', e);
    }
  }

  let saveTimer = null;
  let dirty = false;            // 아직 localStorage 에 반영되지 않은 변경이 있는가
  function persist(immediate) {
    dirty = true;
    clearTimeout(saveTimer);
    const write = () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(store));
        dirty = false;
        flashSaved();
        if (!syncing) scheduleSync();
      } catch (e) {
        console.error(e);
        alert('저장에 실패했습니다. 브라우저 저장공간이 가득 찼을 수 있습니다.\n' +
              '⋯ 메뉴에서 JSON 내보내기로 백업해 주세요.');
      }
    };
    if (immediate) write();
    else saveTimer = setTimeout(write, 400);
  }

  function flashSaved() {
    const el = $('#edStatus');
    if (!el || $('#editor').hidden) return;
    el.textContent = '저장됨';
    el.classList.add('is-saved');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => {
      el.textContent = '자동 저장됩니다';
      el.classList.remove('is-saved');
    }, 1400);
  }

  // ---------- date helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => new Date(s + 'T00:00:00');
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const todayISO = () => iso(new Date());

  function weekStart(d) {                 // 일요일 시작
    const x = new Date(d);
    x.setDate(x.getDate() - x.getDay());
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function fmtLong(s) {
    const d = parse(s);
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  }

  // ---------- data accessors ----------
  const getDay = (s) => store.days[s] || null;

  /* 비워도 항목을 지우지 않고 빈 채로 남긴다. 그래야 "지웠다"는 사실이
     다른 PC 로 전달된다. 한 번도 쓴 적 없는 날만 실제로 지운다. */
  function write(map, s, text, tag) {
    const body = (text || '').replace(/\s+$/, '');
    const cur = map[s];
    const nextTag = tag !== undefined ? tag : (cur ? cur.tag : '');
    if (!body && !nextTag && !cur) return;
    if (cur && cur.text === body && cur.tag === (nextTag || '')) return;
    map[s] = { text: body, tag: nextTag || '', t: Date.now() };
    persist();
  }

  const setDay = (s, text, tag) => write(store.days, s, text, tag);
  const setWeek = (s, text) => write(store.weeks, s, text, '');

  /* 실제로 내용이 있는 날만 센다 (빈 항목은 지운 흔적일 뿐이다) */
  const filledDays = () => Object.keys(store.days).filter((k) => store.days[k].text);

  // ---------- 해야할일 ----------
  // 날짜에 매이지 않고 끝날 때까지 남아 있는 일을 카드로 관리한다.
  // 항목마다 t(마지막 수정 시각)를 두어 날짜 기록과 똑같은 방식으로 기기 간 병합된다.
  const TCOLORS = ['', 'y', 'g', 'b', 'r', 'p'];
  let todoFilter = 'open';
  let todoLayout = 'card';
  let tdOpenId = null;                       // 편집창에 떠 있는 할일
  let tdDirty = false;                       // 창을 연 뒤 사람이 직접 고쳤는가

  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function normItems(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 300)
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({ text: String(it.text || ''), done: !!it.done }));
  }

  function normTodos(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(k) || !v || typeof v !== 'object') continue;
      const t = Number(v.t) || 0;
      if (v.deleted) { out[k] = { deleted: true, t }; continue; }   // 지웠다는 사실도 전파해야 한다
      out[k] = {
        title: String(v.title || ''),
        body: String(v.body || ''),
        items: normItems(v.items),
        color: TCOLORS.includes(v.color) ? v.color : '',
        pinned: !!v.pinned,
        done: !!v.done,
        due: /^\d{4}-\d{2}-\d{2}$/.test(v.due || '') ? v.due : '',
        created: Number(v.created) || t,
        t,
      };
    }
    return out;
  }

  const getTodo = (id) => {
    const v = store.todos[id];
    return v && !v.deleted ? v : null;
  };

  const liveTodos = () =>
    Object.keys(store.todos).filter((k) => !store.todos[k].deleted).map((k) => [k, store.todos[k]]);

  /** 두 할일이 사람이 보기에 같은 내용인가 (t 는 뺀다) */
  function sameTodo(a, b) {
    if (a.title !== b.title || a.body !== b.body || a.color !== b.color) return false;
    if (a.pinned !== b.pinned || a.done !== b.done) return false;
    if (a.items.length !== b.items.length) return false;
    return a.items.every((it, i) => it.text === b.items[i].text && it.done === b.items[i].done);
  }

  /* 바뀐 게 없으면 쓰지 않는다. 그냥 열어보기만 해도 수정시각이 올라가면
     다른 기기에서 먼저 적어 둔 내용이 밀려나기 때문이다. */
  function saveTodo(id, patch) {
    const cur = getTodo(id);
    const base = cur || {
      title: '', body: '', items: [], color: '', pinned: false,
      done: false, due: '', created: Date.now(),
    };
    const next = Object.assign({}, base, patch);
    if (cur && sameTodo(cur, next)) return false;

    next.t = Date.now();
    store.todos[id] = next;
    persist();
    return true;
  }

  function removeTodo(id) {
    store.todos[id] = { deleted: true, t: Date.now() };
    persist();
  }

  function addTodo(title) {
    const id = newId();
    saveTodo(id, { title: title.trim() });
    return id;
  }

  // ---------- 글자 크기 ----------
  // 화면 배율은 기기마다 취향이 달라 동기화하지 않고 이 브라우저에만 둔다
  const FS_KEY = 'cal.fs.v1';

  function applyFontScale(v) {
    const fs = String(Number(v) || 1);
    document.documentElement.style.setProperty('--fs', fs);
    $$('.fsbtns button').forEach((b) => b.classList.toggle('is-on', b.dataset.fs === fs));
    try { localStorage.setItem(FS_KEY, fs); } catch { /* 저장 못해도 이번 세션은 적용된다 */ }
  }

  function loadFontScale() {
    let v = '1';
    try { v = localStorage.getItem(FS_KEY) || '1'; } catch { /* 기본값으로 간다 */ }
    applyFontScale(v);
  }

  // ---------- 메모 글자 크기 ----------
  // 편집창 메모만 따로 키운다. 화면 전체 배율(--fs)과 곱해지므로 둘은 따로 논다.
  // 눈과 화면 크기에 따른 취향이라 동기화하지 않고 이 브라우저에만 둔다.
  const EDFS_KEY = 'cal.edfs.v1';
  const EDFS_MIN = 0.7, EDFS_MAX = 2.5, EDFS_STEP = 0.1;

  function applyEdFont(v) {
    const n = Math.round(Math.min(Math.max(Number(v) || 1, EDFS_MIN), EDFS_MAX) * 10) / 10;
    document.documentElement.style.setProperty('--edfs', String(n));
    $('#edFsVal').textContent = Math.round(n * 100) + '%';
    $('#edFsDown').disabled = n <= EDFS_MIN;
    $('#edFsUp').disabled = n >= EDFS_MAX;
    try { localStorage.setItem(EDFS_KEY, String(n)); } catch { /* 저장 못해도 이번엔 적용된다 */ }
  }

  const edFont = () =>
    Number(getComputedStyle(document.documentElement).getPropertyValue('--edfs')) || 1;

  function loadEdFont() {
    let v = '1';
    try { v = localStorage.getItem(EDFS_KEY) || '1'; } catch { /* 기본값으로 간다 */ }
    applyEdFont(v);
  }

  // ---------- 편집창 너비 ----------
  // 모니터 크기에 따라 다르므로 글자 크기와 마찬가지로 동기화하지 않고 이 브라우저에만 둔다
  const EDW_KEY = 'cal.edw.v1';
  const EDW_MIN = 320;

  // 달력을 옆으로 밀어내는 넓은 화면에서는 달력 쪽에 최소 480px 을 남긴다.
  // 태블릿처럼 편집창이 달력 위에 겹쳐 뜨는 화면에서는 밀 필요가 없으니
  // 뒤를 눌러 닫을 수 있을 만큼(48px)만 남기고 거의 끝까지 넓힐 수 있다.
  const PUSH_MQ = '(min-width: 1100px)';
  const RESIZE_MQ = '(min-width: 621px)';   // 휴대폰(아래에서 올라오는 편집창)만 뺀다
  const edwMax = () => window.matchMedia(PUSH_MQ).matches
    ? Math.max(EDW_MIN, Math.min(window.innerWidth - 480, Math.round(window.innerWidth * 0.75)))
    : Math.max(EDW_MIN, window.innerWidth - 48);

  function applyEdWidth(px, save) {
    const w = Math.round(Math.min(Math.max(px, EDW_MIN), edwMax()));
    document.documentElement.style.setProperty('--edw', w + 'px');
    if (save) { try { localStorage.setItem(EDW_KEY, String(w)); } catch { /* 저장 못해도 이번엔 적용된다 */ } }
    return w;
  }

  function storedEdWidth() {
    try { return Number(localStorage.getItem(EDW_KEY)) || 0; } catch { return 0; }
  }

  // 저장된 값이 없으면 손대지 않는다. 그래야 CSS 기본값(430px, 1700px 이상은 500px)이 그대로 쓰인다
  function loadEdWidth() {
    const v = storedEdWidth();
    if (v) applyEdWidth(v, false);
  }

  // ---------- dom helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // ---------- render ----------
  function render() {
    $$('.segbtn[data-view]').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));

    const searching = query.trim().length > 0;
    $('#viewMonth').hidden = searching || view !== 'month';
    $('#viewWeek').hidden = searching || view !== 'week';
    $('#viewTodo').hidden = searching || view !== 'todo';
    $('#viewSearch').hidden = !searching;

    // 할일 보드는 날짜 개념이 없으므로 이전/다음 화살표를 숨긴다
    document.body.classList.toggle('todo-view', !searching && view === 'todo');
    $('#btnTodo').classList.toggle('is-on', !searching && view === 'todo');
    updateTodoCount();

    if (searching) { renderSearch(); return; }
    if (view === 'month') renderMonth();
    else if (view === 'week') renderWeek();
    else renderTodo();
  }

  function renderTodo() {
    $('#periodLabel').textContent = '해야할일';

    const all = liveTodos();
    const open = all.filter(([, v]) => !v.done);
    const done = all.filter(([, v]) => v.done);

    $('#cOpen').textContent = open.length;
    $('#cDone').textContent = done.length;
    $('#cAll').textContent = all.length;
    $$('#viewTodo .chip').forEach((c) => c.classList.toggle('is-on', c.dataset.filter === todoFilter));
    $$('#viewTodo .segbtn').forEach((b) => b.classList.toggle('is-on', b.dataset.layout === todoLayout));

    const list = todoFilter === 'done' ? done : todoFilter === 'all' ? all : open;

    // 고정 → 미완료 → 최근에 고친 순
    list.sort(([, a], [, b]) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.t - a.t;
    });

    const wrap = $('#todoWrap');
    wrap.className = 'todo-wrap as-' + todoLayout;
    wrap.innerHTML = '';

    if (!list.length) {
      wrap.appendChild(el('div', 'empty', todoFilter === 'done'
        ? '아직 완료한 일이 없습니다.'
        : '위 칸에 할 일을 적고 Enter 를 누르세요.'));
      return;
    }

    for (const [id, v] of list) wrap.appendChild(todoCard(id, v));
  }

  function todoCard(id, v) {
    const card = el('article', `todo${v.color ? ' c-' + v.color : ''}${v.done ? ' is-done' : ''}`);
    card.dataset.id = id;

    const steps = v.items.length;
    const doneSteps = v.items.filter((i) => i.done).length;

    const preview = v.body
      ? `<p class="t-body">${esc(v.body)}</p>`
      : (steps ? '' : '<p class="t-body t-empty">내용 없음</p>');

    const stepList = steps
      ? '<ul class="t-steps">' + v.items.slice(0, 6).map((it, i) =>
          `<li class="${it.done ? 'on' : ''}"><button class="sbox" data-step="${i}"
             aria-label="${esc(it.text)} ${it.done ? '완료 취소' : '완료'}"></button>
             <span>${esc(it.text)}</span></li>`).join('')
        + (steps > 6 ? `<li class="more">그 외 ${steps - 6}개</li>` : '') + '</ul>'
      : '';

    card.innerHTML =
      `<div class="t-head">
         <button class="t-chk" data-act="done" aria-pressed="${v.done}"
                 title="${v.done ? '진행중으로 되돌리기' : '완료로 표시'}"></button>
         <h3 class="t-title">${esc(v.title || '(제목 없음)')}</h3>
         <button class="t-pin${v.pinned ? ' on' : ''}" data-act="pin"
                 title="${v.pinned ? '고정 해제' : '위로 고정'}" aria-pressed="${v.pinned}">📌</button>
       </div>
       ${preview}
       ${stepList}
       <div class="t-foot">
         ${steps ? `<span class="t-prog">${doneSteps}/${steps}</span>` : ''}
         <span class="grow"></span>
         <span class="t-when">${fmtWhen(v.t)}</span>
       </div>`;
    return card;
  }

  function fmtWhen(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const days = Math.round((parse(todayISO()) - parse(iso(d))) / 86400000);
    if (days === 0) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return '어제';
    if (days < 7) return `${days}일 전`;
    return `${d.getMonth() + 1}.${d.getDate()}`;
  }

  function renderMonth() {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    $('#periodLabel').textContent = `${y}년 ${m + 1}월`;

    const root = $('#viewMonth');
    root.innerHTML = '';

    const head = el('div', 'dow');
    DOW.forEach((d) => head.appendChild(el('div', null, d)));
    root.appendChild(head);

    const grid = el('div', 'grid');
    let d = weekStart(new Date(y, m, 1));
    const today = todayISO();

    for (let i = 0; i < 42; i++) {
      const s = iso(d);
      const entry = getDay(s);
      const hol = window.holidayName(s);
      const cls = ['cell', `dow-${d.getDay()}`];
      if (d.getMonth() !== m) cls.push('is-out');
      if (s === today) cls.push('is-today');
      if (hol) cls.push('is-hol');
      if (entry && entry.tag) cls.push('t-' + entry.tag);
      if (entry && entry.text) cls.push('has-entry');

      const cell = el('button', cls.join(' '));
      cell.type = 'button';
      cell.dataset.date = s;
      cell.setAttribute('aria-label', fmtLong(s));
      cell.innerHTML =
        `<div class="d"><span class="num">${d.getDate()}</span>` +
        (hol ? `<span class="hol">${esc(hol)}</span>` : '') + '</div>' +
        `<div class="body">${entry ? esc(entry.text) : ''}</div>` +
        (entry && entry.text.length > 40 ? '<div class="fade"></div>' : '');

      grid.appendChild(cell);
      d = addDays(d, 1);
    }
    root.appendChild(grid);
  }

  function renderWeek() {
    const start = weekStart(cursor);
    const end = addDays(start, 6);
    const sIso = iso(start);
    $('#periodLabel').textContent =
      `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${start.getDate()}일` +
      ` – ${end.getMonth() + 1}월 ${end.getDate()}일`;

    const root = $('#viewWeek');
    root.innerHTML = '';

    const goal = el('div', 'wk-goal');
    goal.innerHTML = '<div class="lab">주간목표</div>';
    const gta = el('textarea');
    gta.value = (store.weeks[sIso] || {}).text || '';
    gta.placeholder = '이번 주에 꼭 해야 할 일';
    gta.addEventListener('input', () => setWeek(sIso, gta.value));
    goal.appendChild(gta);
    root.appendChild(goal);

    const wk = el('div', 'wk');
    const today = todayISO();

    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      const s = iso(d);
      const entry = getDay(s);
      const hol = window.holidayName(s);
      const cls = ['wkday', `dow-${i}`];
      if (s === today) cls.push('is-today');
      if (hol) cls.push('is-hol');
      if (entry && entry.tag) cls.push('t-' + entry.tag);

      const box = el('div', cls.join(' '));
      box.innerHTML =
        `<div class="h"><span>${d.getMonth() + 1}.${d.getDate()} ${DOW[i]}</span>` +
        (hol ? `<span class="hn">${esc(hol)}</span>` : '') + '</div>';

      const ta = el('textarea');
      ta.value = entry ? entry.text : '';
      ta.placeholder = '자유롭게 기록';
      ta.addEventListener('input', () => setDay(s, ta.value));
      ta.addEventListener('blur', () => { persist(true); if (view === 'week') renderWeekTagsOnly(); });
      box.appendChild(ta);
      wk.appendChild(box);
    }
    root.appendChild(wk);
  }

  /** 편집 중인 날짜 칸만 제자리에서 갱신한다 (전체 render 는 포커스를 잃게 하므로) */
  function refreshCell(s) {
    const entry = getDay(s);
    const cell = document.querySelector(`.cell[data-date="${s}"]`);
    if (cell) {
      TAGS.filter(Boolean).forEach((t) => cell.classList.remove('t-' + t));
      if (entry && entry.tag) cell.classList.add('t-' + entry.tag);
      cell.classList.toggle('has-entry', !!(entry && entry.text));
      const body = cell.querySelector('.body');
      if (body) body.textContent = entry ? entry.text : '';
      const fade = cell.querySelector('.fade');
      const needFade = entry && entry.text.length > 40;
      if (needFade && !fade) cell.appendChild(el('div', 'fade'));
      if (!needFade && fade) fade.remove();
    }
    if (view === 'week') renderWeekTagsOnly();
  }

  // 주간 뷰에서 입력 중 커서가 튀지 않도록 태그 클래스만 다시 칠한다
  function renderWeekTagsOnly() {
    const start = weekStart(cursor);
    $$('#viewWeek .wkday').forEach((box, i) => {
      const s = iso(addDays(start, i));
      const entry = getDay(s);
      TAGS.filter(Boolean).forEach((t) => box.classList.remove('t-' + t));
      if (entry && entry.tag) box.classList.add('t-' + entry.tag);
    });
  }

  function renderSearch() {
    const q = query.trim().toLowerCase();
    $('#periodLabel').textContent = '검색';

    const hits = Object.keys(store.days)
      .filter((s) => (store.days[s].text || '').toLowerCase().includes(q))
      .sort()
      .reverse();

    const root = $('#viewSearch');
    root.innerHTML = '';

    if (!hits.length) {
      root.appendChild(el('div', 'empty', `"${esc(query)}" 에 대한 기록이 없습니다.`));
      return;
    }

    root.appendChild(el('div', 'rescount', `${hits.length}일의 기록을 찾았습니다.`));
    const list = el('div', 'results');

    hits.slice(0, 300).forEach((s) => {
      const text = store.days[s].text;
      const at = text.toLowerCase().indexOf(q);
      const from = Math.max(0, at - 60);
      const snippet = (from > 0 ? '…' : '') + text.slice(from, at + q.length + 160);

      // 원문에서 먼저 잘라낸 뒤 조각마다 이스케이프해야 &, < 가 든 검색어도 안전하다
      const re = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      let marked = '', last = 0, mm;
      while ((mm = re.exec(snippet)) !== null) {
        marked += esc(snippet.slice(last, mm.index)) + `<mark>${esc(mm[0])}</mark>`;
        last = mm.index + mm[0].length;
        if (mm[0].length === 0) re.lastIndex++;
      }
      marked += esc(snippet.slice(last));

      const b = el('button', 'res');
      b.type = 'button';
      b.dataset.date = s;
      b.innerHTML = `<div class="rd">${fmtLong(s)}</div><div class="rt">${marked}</div>`;
      list.appendChild(b);
    });

    root.appendChild(list);
    if (hits.length > 300) {
      root.appendChild(el('div', 'empty', '상위 300건만 표시했습니다. 검색어를 좁혀 보세요.'));
    }
  }

  // ---------- editor ----------
  function openEditor(s) {
    selected = s;
    const entry = getDay(s) || { text: '', tag: '' };
    const hol = window.holidayName(s);

    $('#edDate').textContent = fmtLong(s);
    $('#edSub').innerHTML = hol
      ? `<span class="hol">${esc(hol)}</span>`
      : `${diffLabel(s)}`;
    $('#edText').value = entry.text;
    $$('.tag').forEach((t) => t.classList.toggle('is-on', t.dataset.tag === (entry.tag || '')));

    $('#editor').hidden = false;
    document.body.classList.add('editing');   // 넓은 화면에서 달력을 옆으로 밀어낸다
    // 밀어낼 자리가 없어 달력 위에 겹쳐 뜨는 화면에서만 뒤를 어둡게 한다
    if (!window.matchMedia(PUSH_MQ).matches) $('#scrim').hidden = false;
    location.hash = s;
    setTimeout(() => $('#edText').focus(), 30);
  }

  function diffLabel(s) {
    const days = Math.round((parse(s) - parse(todayISO())) / 86400000);
    if (days === 0) return '오늘';
    if (days === 1) return '내일';
    if (days === -1) return '어제';
    return days > 0 ? `${days}일 후` : `${-days}일 전`;
  }

  function closeEditor() {
    if (!selected) return;
    persist(true);
    selected = null;
    $('#editor').hidden = true;
    document.body.classList.remove('editing');
    $('#scrim').hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    render();
  }

  function currentTag() {
    const on = $('.tag.is-on');
    return on ? on.dataset.tag : '';
  }

  // ---------- 할일 편집창 ----------
  function fillTodoDialog(v) {
    $('#tdTitle').value = v.title;
    $('#tdBody').value = v.body;
    $('#tdPin').setAttribute('aria-pressed', String(v.pinned));
    $('#tdPin').classList.toggle('on', v.pinned);
    $('#tdDone').textContent = v.done ? '진행중으로 되돌리기' : '완료로 표시';
    $$('#tdColors .sw').forEach((b) => b.classList.toggle('is-on', b.dataset.color === v.color));
    renderTdItems(v.items);
  }

  function openTodo(id) {
    const v = getTodo(id);
    if (!v) return;
    tdOpenId = id;
    tdDirty = false;
    fillTodoDialog(v);

    $('#dlgTodo').showModal();
    if (!v.title) setTimeout(() => $('#tdTitle').focus(), 30);
  }

  /* 다른 기기에서 받아온 내용이 더 최신이면 열려 있는 창에도 반영한다.
     단, 지금 타이핑 중이라면 건드리지 않는다. */
  function refreshOpenTodo() {
    if (!tdOpenId || tdDirty) return;
    const v = getTodo(tdOpenId);
    if (v) fillTodoDialog(v);
    else { tdOpenId = null; $('#dlgTodo').close(); }   // 다른 기기에서 지운 경우
  }

  function renderTdItems(items) {
    const box = $('#tdItems');
    box.innerHTML = '';
    items.forEach((it, i) => {
      const row = el('div', 'td-item' + (it.done ? ' on' : ''));
      row.innerHTML =
        `<button class="sbox" data-i="${i}" aria-label="${it.done ? '완료 취소' : '완료'}"></button>
         <input type="text" value="${esc(it.text)}" data-i="${i}" placeholder="단계 내용">
         <button class="xbtn" data-del="${i}" aria-label="이 단계 지우기">✕</button>`;
      box.appendChild(row);
    });
  }

  /** 편집창의 현재 내용을 저장한다 (사람이 고쳤을 때만 호출된다) */
  function flushTodo() {
    if (!tdOpenId) return false;
    const items = $$('#tdItems .td-item').map((row) => ({
      text: $('input', row).value,
      done: row.classList.contains('on'),
    })).filter((it) => it.text.trim() || it.done);

    const wrote = saveTodo(tdOpenId, {
      title: $('#tdTitle').value.trim(),
      body: $('#tdBody').value.replace(/\s+$/, ''),
      items,
    });
    if (!wrote) return false;              // 바뀐 게 없으면 저장했다고 하지 않는다

    tdDirty = true;
    tdFlash('저장됨');
    return true;
  }

  function closeTodo() {
    if (!tdOpenId) return;
    if (flushTodo()) persist(true);        // 고친 게 있을 때만 저장·동기화한다
    tdOpenId = null;
    tdDirty = false;
    $('#dlgTodo').close();
    if (view === 'todo') renderTodo();
    updateTodoCount();
  }

  function updateTodoCount() {
    const n = liveTodos().filter(([, v]) => !v.done).length;
    const badge = $('#todoCount');
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  // ---------- import / export ----------
  function doExport() {
    const payload = {
      version: 1,
      app: 'kimchul123/cal',
      exportedAt: new Date().toISOString(),
      days: store.days,
      weeks: store.weeks,
      todos: store.todos,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `calendar-backup-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- 엑셀 내보내기 ----------
  // 외부 라이브러리 없이 .xlsx 를 직접 만든다. xlsx 는 XML 몇 개를 zip 으로 묶은 것이라
  // 압축 없이(stored) 묶기만 해도 엑셀이 그대로 연다. 기록이 서버로 나가지 않는 원칙도 지킨다.

  const TAG_LABEL = { '': '', important: '중요', holiday: '휴일', done: '완료' };

  // XML 에 넣을 수 없는 제어문자는 빼고, 엑셀 한 칸의 한도(32,767자)를 넘으면 자른다
  const xmlText = (s) => String(s)
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .slice(0, 32767)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const colName = (i) => String.fromCharCode(65 + i);          // 열은 많아야 5개다
  const excelDate = (s) => {                                      // 1900 날짜 체계의 일련번호
    const [y, m, d] = s.split('-').map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  };

  /* rows 의 각 칸은 { v, s, date } 다. s 는 styles.xml 의 cellXfs 번호다. */
  function sheetXml(widths, rows) {
    const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const body = rows.map((r, ri) => {
      const cells = r.map((c, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (c.date) return `<c r="${ref}" s="${c.s}"><v>${excelDate(c.v)}</v></c>`;
        if (c.v === '' || c.v == null) return `<c r="${ref}" s="${c.s}"/>`;
        return `<c r="${ref}" s="${c.s}" t="inlineStr"><is><t xml:space="preserve">${xmlText(c.v)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const last = colName(widths.length - 1) + Math.max(rows.length, 1);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${cols}</cols><sheetData>${body}</sheetData>` +
      `<autoFilter ref="A1:${last}"/></worksheet>`;
  }

  // 0 기본 · 1 머리글 · 2 날짜 · 3 위쪽 정렬 · 4 줄바꿈 · 5~7 줄바꿈 + 표시 색(중요/휴일/완료)
  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font>' +
    '<font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>' +
    '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F0FE"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6D6"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFDECEC"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F4"/></patternFill></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
    '<cellXfs count="8">' +
    '<xf/>' +
    '<xf fontId="1" fillId="2" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="164" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf applyAlignment="1"><alignment vertical="top"/></xf>' +
    '<xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf fillId="3" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf fillId="4" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf fillId="5" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '</cellXfs></styleSheet>';

  const TAG_STYLE = { important: 5, holiday: 6, done: 7 };

  function buildXlsx() {
    const H = (v) => ({ v, s: 1 });

    const dayRows = [[H('날짜'), H('요일'), H('공휴일'), H('표시'), H('내용')]];
    Object.keys(store.days)
      .filter((s) => store.days[s].text || store.days[s].tag)
      .sort()
      .forEach((s) => {
        const e = store.days[s];
        dayRows.push([
          { v: s, s: 2, date: true },
          { v: DOW[parse(s).getDay()], s: 3 },
          { v: window.holidayName(s) || '', s: 3 },
          { v: TAG_LABEL[e.tag] || '', s: 3 },
          { v: e.text, s: TAG_STYLE[e.tag] || 4 },
        ]);
      });

    const weekRows = [[H('주 시작일'), H('기간'), H('주간목표')]];
    Object.keys(store.weeks)
      .filter((s) => store.weeks[s].text)
      .sort()
      .forEach((s) => {
        const end = addDays(parse(s), 6);
        weekRows.push([
          { v: s, s: 2, date: true },
          { v: `${fmtLong(s).replace(/ \(.\)$/, '')} – ${end.getMonth() + 1}월 ${end.getDate()}일`, s: 3 },
          { v: store.weeks[s].text, s: 4 },
        ]);
      });

    const ns = 'http://schemas.openxmlformats.org';
    const files = {
      '[Content_Types].xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Types xmlns="${ns}/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
      '_rels/.rels':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${ns}/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
      'xl/workbook.xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships">` +
        '<sheets><sheet name="일별 기록" sheetId="1" r:id="rId1"/><sheet name="주간목표" sheetId="2" r:id="rId2"/></sheets>' +
        '<definedNames>' +
        `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'일별 기록'!$A$1:$E$${dayRows.length}</definedName>` +
        `<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'주간목표'!$A$1:$C$${weekRows.length}</definedName>` +
        '</definedNames></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${ns}/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
      'xl/styles.xml': STYLES_XML,
      'xl/worksheets/sheet1.xml': sheetXml([12, 6, 14, 7, 90], dayRows),
      'xl/worksheets/sheet2.xml': sheetXml([12, 30, 90], weekRows),
    };
    return { blob: zipStore(files), days: dayRows.length - 1, weeks: weekRows.length - 1 };
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** 압축하지 않고 묶기만 하는 zip. 파일 이름이 모두 영문이라 UTF-8 플래그는 필요 없다. */
  function zipStore(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const parts = [], central = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameB.length, true);
      parts.push(local, nameB, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameB.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd, nameB);

      offset += 30 + nameB.length + data.length;
    }

    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(files).length, true);
    end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function doExportXlsx() {
    const { blob, days } = buildXlsx();
    if (!days && !confirm('아직 기록이 없습니다. 빈 엑셀 파일을 받을까요?')) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `캘린더-기록-${todayISO()}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function doImport(file) {
    const rd = new FileReader();
    rd.onload = () => {
      let o;
      try { o = JSON.parse(rd.result); }
      catch { alert('JSON 파일을 읽지 못했습니다.'); return; }

      const days = o && o.days;
      if (!days || typeof days !== 'object') { alert('days 항목이 없는 파일입니다.'); return; }

      const n = Object.keys(days).length;
      if (!confirm(`${n}일의 기록을 가져옵니다.\n같은 날짜는 가져온 내용으로 덮어씁니다.\n계속할까요?`)) return;

      // 가져온 쪽을 그대로 쓰되, 지금 시각을 찍어 다른 PC 로도 이 내용이 퍼지게 한다
      const now = Date.now();
      Object.assign(store.days, normMap(days));
      Object.assign(store.weeks, normMap(o.weeks));
      Object.assign(store.todos, normTodos(o.todos));
      for (const k of Object.keys(normMap(days))) store.days[k].t = now;
      for (const k of Object.keys(normMap(o.weeks))) store.weeks[k].t = now;
      for (const k of Object.keys(normTodos(o.todos))) store.todos[k].t = now;

      persist(true);
      render();
      alert(`가져오기 완료 — 총 ${filledDays().length}일의 기록이 있습니다.`);
      scheduleSync();
    };
    rd.readAsText(file, 'utf-8');
  }

  // ---------- GitHub 동기화 ----------
  // 기록을 내 비공개 저장소의 JSON 파일 하나에 보관한다.
  // 올리기 전에 반드시 먼저 내려받아 합치므로, 다른 PC 가 쓴 내용을 덮어쓰지 않는다.

  let sync = { repo: '', token: '', path: 'diary.json' };
  let syncing = false;
  let syncTimer = null;

  function loadSync() {
    try {
      const o = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
      sync = { repo: o.repo || '', token: o.token || '', path: o.path || 'diary.json' };
    } catch { /* 설정이 깨졌으면 그냥 꺼진 상태로 시작한다 */ }
  }

  const syncOn = () => Boolean(sync.repo && sync.token);

  function saveSync() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { console.error(e); }
  }

  function setSyncState(state, note) {
    const chip = $('#syncChip');
    chip.dataset.state = state;
    $('#syncText').textContent = {
      off: '동기화 꺼짐',
      syncing: '동기화 중…',
      ok: note || '동기화됨',
      error: note || '동기화 실패',
    }[state] || state;
    chip.title = state === 'off'
      ? '기기 간 동기화 설정 — 회사 PC와 집 PC에서 같은 기록 보기'
      : `${sync.repo}/${sync.path}${note ? ' — ' + note : ''}`;
  }

  // atob/btoa 는 바이트 단위라 한글이 깨진다. UTF-8 로 직접 바꿔 준다.
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function gh(method, extra) {
    const url = `https://api.github.com/repos/${sync.repo}/contents/${sync.path}`;
    const res = await fetch(method === 'GET' ? `${url}?ref=HEAD&t=${Date.now()}` : url, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${sync.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: extra ? JSON.stringify(extra) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;   // 첫 동기화라 파일이 아직 없다
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      const e = new Error(`GitHub ${res.status}`);
      e.status = res.status;
      e.detail = msg.slice(0, 300);
      throw e;
    }
    return res.json();
  }

  /* contents API 는 1MB 가 넘는 파일의 내용을 돌려주지 않는다(content 가 빈 값).
     기록이 쌓여 그 선을 넘으면 blob API 로 받아온다. */
  async function fileContent(file) {
    if (file.content) return b64decode(file.content);
    const res = await fetch(`https://api.github.com/repos/${sync.repo}/git/blobs/${file.sha}`, {
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${sync.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
    const blob = await res.json();
    return b64decode(blob.content);
  }

  /** 최신인 쪽만 남기고 합친다. 같은 날을 양쪽에서 고쳤다면 나중에 고친 쪽이 이긴다. */
  function mergeInto(target, incoming) {
    let changed = false;
    for (const [k, v] of Object.entries(incoming)) {
      const cur = target[k];
      if (!cur || v.t > cur.t) { target[k] = v; changed = true; }
    }
    return changed;
  }

  // 쓸 때마다 t 가 올라가므로 t 만 모아도 "같은 내용인가" 를 가릴 수 있다.
  // 날짜 기록과 할일이 형태가 달라도 이 함수 하나로 비교된다.
  const fingerprint = (m) =>
    Object.keys(m).sort().map((k) => `${k}:${m[k].t}`).join('|');

  const stamp = () =>
    fingerprint(store.days) + '#' + fingerprint(store.weeks) + '#' + fingerprint(store.todos);

  async function syncNow(manual) {
    if (!syncOn()) { if (manual) openSyncDialog(); return; }
    if (syncing) return;
    syncing = true;
    setSyncState('syncing');

    try {
      const file = await gh('GET');
      let remote = { days: {}, weeks: {}, todos: {} };
      if (file) {
        const raw = await fileContent(file);
        let o;
        try { o = JSON.parse(raw); }
        catch { throw new Error(`${sync.path} 을 읽지 못했습니다 (JSON 형식 오류)`); }
        remote = { days: normMap(o.days), weeks: normMap(o.weeks), todos: normTodos(o.todos) };
      }

      const before = stamp();
      const pulled = mergeInto(store.days, remote.days)
        | mergeInto(store.weeks, remote.weeks)
        | mergeInto(store.todos, remote.todos);
      const after = stamp();

      if (pulled) {
        persist(true);
        refreshOpenTodo();                       // 받아온 내용이 열린 창에도 보이게 한다
        if (!selected && !tdOpenId) render();
      }

      const remoteFp = fingerprint(remote.days) + '#' + fingerprint(remote.weeks)
        + '#' + fingerprint(remote.todos);
      if (after !== remoteFp) {
        const payload = {
          version: 2,
          app: 'kimchul123/cal',
          updatedAt: new Date().toISOString(),
          days: store.days,
          weeks: store.weeks,
          todos: store.todos,
        };
        await gh('PUT', {
          message: `기록 갱신 ${new Date().toLocaleString('ko-KR')}`,
          content: b64encode(JSON.stringify(payload, null, 1)),
          sha: file ? file.sha : undefined,
        });
      }

      const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      setSyncState('ok', `${time} 동기화`);
      if (before !== after && manual) alert('다른 기기의 기록을 받아왔습니다.');
    } catch (e) {
      console.error(e);
      let note = '동기화 실패';
      if (e.status === 401) note = '토큰이 올바르지 않음';
      else if (e.status === 403) note = '토큰 권한 부족';
      else if (e.status === 404) note = '저장소를 찾을 수 없음';
      else if (e.status === 409 || e.status === 422) note = '충돌 — 다시 시도하세요';
      else if (e.name === 'TypeError') note = '네트워크 오프라인';
      setSyncState('error', note);
      if (manual) alert(`동기화하지 못했습니다: ${note}\n\n${e.detail || e.message}`);
    } finally {
      syncing = false;
    }
  }

  /** 글을 고친 뒤 잠시 기다렸다가 한 번만 올린다 (타이핑마다 올리지 않는다) */
  function scheduleSync() {
    if (!syncOn()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(false), 4000);
  }

  function openSyncDialog() {
    $('#syncRepo').value = sync.repo;
    $('#syncToken').value = sync.token;
    $('#syncMsg').hidden = true;
    $('#dlgSync').showModal();
  }

  function showStats() {
    const byYear = {};
    let chars = 0;
    for (const s of filledDays()) {
      const y = s.slice(0, 4);
      byYear[y] = (byYear[y] || 0) + 1;
      chars += store.days[s].text.length;
    }
    const years = Object.keys(byYear).sort();
    const rows = years.map((y) => `<tr><td>${y}년</td><td>${byYear[y]}일</td></tr>`).join('');

    $('#dlgBody').innerHTML =
      '<h3>기록 통계</h3>' +
      `<table><tr><td>전체 기록</td><td>${filledDays().length}일</td></tr>` +
      `<tr><td>주간목표</td><td>${Object.keys(store.weeks).filter((k) => store.weeks[k].text).length}주</td></tr>` +
      `<tr><td>총 글자수</td><td>${chars.toLocaleString('ko-KR')}자</td></tr>` +
      rows + '</table>';
    $('#dlg').showModal();
  }

  // ---------- events ----------
  // ---------- 할일 이벤트 ----------
  $('#btnTodo').onclick = () => {
    if (query) { query = ''; $('#q').value = ''; }
    view = view === 'todo' ? 'month' : 'todo';
    render();
  };

  function createFromInput() {
    const input = $('#todoNew');
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    const id = addTodo(title);
    persist(true);
    renderTodo();
    updateTodoCount();
    openTodo(id);                      // 바로 내용을 채울 수 있게 편집창을 연다
  }

  $('#todoAdd').onclick = createFromInput;
  $('#todoNew').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createFromInput(); }
  });

  $('#viewTodo').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) { todoFilter = chip.dataset.filter; renderTodo(); return; }

    const seg = e.target.closest('#viewTodo .segbtn');
    if (seg) { todoLayout = seg.dataset.layout; renderTodo(); return; }

    const card = e.target.closest('.todo');
    if (!card) return;
    const id = card.dataset.id;
    const v = getTodo(id);
    if (!v) return;

    const step = e.target.closest('.sbox');
    if (step) {                                   // 카드에서 바로 단계를 체크한다
      const i = Number(step.dataset.step);
      const items = v.items.map((it, k) => (k === i ? { ...it, done: !it.done } : it));
      saveTodo(id, { items });
      persist(true);
      renderTodo();
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'done') saveTodo(id, { done: !v.done, pinned: v.done ? v.pinned : false });
      else saveTodo(id, { pinned: !v.pinned });
      persist(true);
      renderTodo();
      updateTodoCount();
      return;
    }

    openTodo(id);
  });

  // --- 편집창 ---
  $('#tdClose').onclick = closeTodo;
  $('#dlgTodo').addEventListener('close', () => { if (tdOpenId) closeTodo(); });
  $('#dlgTodo').addEventListener('cancel', (e) => { e.preventDefault(); closeTodo(); });

  ['#tdTitle', '#tdBody'].forEach((sel) =>
    $(sel).addEventListener('input', flushTodo));

  // ---------- 내보내기 (카카오톡 등) ----------
  /** 편집창 아래 안내줄에 잠깐 띄운다 */
  function tdFlash(msg) {
    const el = $('#tdStatus');
    el.textContent = msg;
    clearTimeout(tdFlash._t);
    tdFlash._t = setTimeout(() => { el.textContent = '자동 저장됩니다'; }, 2600);
  }

  /** 제목 + 본문 + 단계를 남에게 보낼 수 있는 글로 만든다 */
  function todoAsText() {
    const v = getTodo(tdOpenId);
    if (!v) return '';
    const steps = v.items.length
      ? '\n\n■ 단계\n' + v.items.map((it) => `${it.done ? '☑' : '☐'} ${it.text}`).join('\n')
      : '';
    return `[${v.title || '할 일'}]\n\n${v.body}${steps}`.trim();
  }

  async function copyTodo() {
    const text = todoAsText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // https 가 아니거나 권한이 없을 때를 위한 옛 방식
      const ta = el('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* 이것도 막히면 알릴 수밖에 없다 */ }
      ta.remove();
    }
    tdFlash(`${text.length}자 복사했습니다 — 카카오톡에 붙여넣으세요`);
  }

  $('#tdCopy').onclick = copyTodo;

  // 휴대폰처럼 공유창이 있는 기기에서만 공유 버튼을 띄운다
  if (navigator.share) {
    $('#tdShare').hidden = false;
    $('#tdShare').onclick = async () => {
      const v = getTodo(tdOpenId);
      if (!v) return;
      try {
        await navigator.share({ title: v.title || '할 일', text: todoAsText() });
      } catch (e) {
        if (e && e.name === 'AbortError') return;    // 사용자가 공유창을 닫은 것뿐이다
        copyTodo();                                   // 공유가 막히면 복사로 대신한다
      }
    };
  }

  /* 통화·방문 기록을 적을 때 날짜를 매번 치지 않도록 커서 자리에 넣어 준다 */
  $('#tdStamp').onclick = () => {
    const ta = $('#tdBody');
    const n = new Date();
    const text = `[${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} `
      + `${pad(n.getHours())}:${pad(n.getMinutes())}] `;
    const a = ta.selectionStart, b = ta.selectionEnd;
    const head = ta.value.slice(0, a);
    const nl = head && !head.endsWith('\n') ? '\n' : '';     // 줄 중간이면 새 줄에서 시작한다
    ta.value = head + nl + text + ta.value.slice(b);
    const pos = a + nl.length + text.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    flushTodo();
  };

  $('#tdItems').addEventListener('input', flushTodo);

  $('#tdItems').addEventListener('click', (e) => {
    const box = e.target.closest('.sbox');
    if (box) { box.closest('.td-item').classList.toggle('on'); flushTodo(); return; }

    const del = e.target.closest('[data-del]');
    if (del) { del.closest('.td-item').remove(); flushTodo(); }
  });

  // 단계 칸에서 Enter 를 누르면 다음 단계를 바로 잇는다
  $('#tdItems').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    addItemRow();
  });

  function addItemRow() {
    const box = $('#tdItems');
    const row = el('div', 'td-item');
    row.innerHTML =
      `<button class="sbox" aria-label="완료"></button>
       <input type="text" placeholder="단계 내용">
       <button class="xbtn" data-del="x" aria-label="이 단계 지우기">✕</button>`;
    box.appendChild(row);
    $('input', row).focus();
  }
  $('#tdAddItem').onclick = addItemRow;

  $('#tdPin').onclick = () => {
    if (!tdOpenId) return;
    const v = getTodo(tdOpenId);
    saveTodo(tdOpenId, { pinned: !v.pinned });
    $('#tdPin').classList.toggle('on', !v.pinned);
    $('#tdPin').setAttribute('aria-pressed', String(!v.pinned));
  };

  $('#tdColors').addEventListener('click', (e) => {
    const sw = e.target.closest('.sw');
    if (!sw || !tdOpenId) return;
    saveTodo(tdOpenId, { color: sw.dataset.color });
    $$('#tdColors .sw').forEach((b) => b.classList.toggle('is-on', b === sw));
  });

  $('#tdDone').onclick = () => {
    if (!tdOpenId) return;
    flushTodo();
    const v = getTodo(tdOpenId);
    saveTodo(tdOpenId, { done: !v.done, pinned: v.done ? v.pinned : false });
    closeTodo();
  };

  $('#tdDelete').onclick = () => {
    if (!tdOpenId) return;
    const v = getTodo(tdOpenId);
    if (!confirm(`"${v.title || '제목 없음'}" 을 지웁니다. 되돌릴 수 없습니다.\n계속할까요?`)) return;
    removeTodo(tdOpenId);
    persist(true);
    tdOpenId = null;
    $('#dlgTodo').close();
    renderTodo();
    updateTodoCount();
  };

  function step(dir, axis) {
    if (view === 'todo') return;          // 할일 보드는 날짜를 넘길 대상이 아니다
    if (view === 'month') {
      // 31일에서 setMonth 를 쓰면 다음 달을 건너뛰므로 항상 1일 기준으로 옮긴다
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
    } else {
      cursor = addDays(cursor, 7 * dir);
    }
    render();
    if (axis) slideIn(axis, dir);
  }

  /** 스와이프로 넘겼을 때 어느 쪽으로 움직였는지 눈에 보이게 한다 */
  function slideIn(axis, dir) {
    const el = view === 'month' ? $('#viewMonth') : $('#viewWeek');
    const cls = `slide-${axis}${dir > 0 ? '-next' : '-prev'}`;
    el.classList.remove('slide-y-next', 'slide-y-prev', 'slide-x-next', 'slide-x-prev');
    void el.offsetWidth;                       // 애니메이션을 다시 시작시키기 위한 강제 리플로우
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  /* 편집창 왼쪽 가장자리를 끌어 너비를 바꾼다. 왼쪽으로 끌수록 넓어진다.
     pointer 이벤트라 마우스와 손가락(태블릿) 모두 같은 코드로 동작한다. */
  (function enableEdResize() {
    const handle = $('#edResize');
    let x0 = 0, w0 = 0, dragging = false;
    const edWidth = () => $('#editor').getBoundingClientRect().width;

    handle.addEventListener('pointerdown', (e) => {
      if (!window.matchMedia(RESIZE_MQ).matches) return;
      dragging = true;
      x0 = e.clientX;
      w0 = edWidth();
      document.body.classList.add('resizing');
      e.preventDefault();
      // 커서가 손잡이를 벗어나도 따라오게 한다. 캡처가 안 되더라도 window 쪽에서 받는다
      try { handle.setPointerCapture(e.pointerId); } catch { /* 캡처 없이도 동작한다 */ }
    });

    window.addEventListener('pointermove', (e) => {
      if (dragging) applyEdWidth(w0 + (x0 - e.clientX), false);
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* 이미 놓였으면 그만이다 */ }
      document.body.classList.remove('resizing');
      applyEdWidth(edWidth(), true);          // 끝났을 때 한 번만 저장한다
    }
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    handle.addEventListener('dblclick', () => {
      try { localStorage.removeItem(EDW_KEY); } catch { /* 지울 게 없으면 그만이다 */ }
      document.documentElement.style.removeProperty('--edw');
    });

    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      applyEdWidth(edWidth() + (e.key === 'ArrowLeft' ? 24 : -24), true);
    });

    // 창을 줄이면 저장해 둔 너비가 한도를 넘을 수 있다. 저장값은 그대로 두고 화면에만 맞춘다
    window.addEventListener('resize', () => {
      const v = storedEdWidth();
      if (v) applyEdWidth(v, false);
    });
  })();

  /* 휴대폰에서 손가락으로 쓸어 달(주)을 넘긴다.
     세로 스와이프는 화면이 스크롤되지 않을 때만 쓴다. 스크롤을 뺏으면 안 되기 때문이다. */
  (function enableSwipe() {
    const MIN = 45;        // 이만큼은 움직여야 스와이프로 인정한다
    const MAX_MS = 800;
    let x0 = 0, y0 = 0, t0 = 0, on = false;
    const area = $('#main');

    area.addEventListener('touchstart', (e) => {
      on = false;
      if (e.touches.length !== 1) return;                       // 두 손가락은 확대/축소다
      if (view === 'todo') return;                              // 할일 보드에서는 넘기지 않는다
      if (!$('#editor').hidden || query.trim()) return;          // 편집 중 · 검색 중에는 넘기지 않는다
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); on = true;
    }, { passive: true });

    area.addEventListener('touchend', (e) => {
      if (!on) return;
      on = false;
      if (Date.now() - t0 > MAX_MS) return;

      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      const ax = Math.abs(dx), ay = Math.abs(dy);

      if (ax > ay) {
        if (ax > MIN) step(dx < 0 ? 1 : -1, 'x');     // 왼쪽으로 쓸면 다음
      } else if (ay > MIN && !pageScrolls()) {
        step(dy < 0 ? 1 : -1, 'y');                   // 위로 쓸면 다음
      }
    }, { passive: true });

    const pageScrolls = () =>
      document.documentElement.scrollHeight > window.innerHeight + 4;
  })();

  document.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell, .res');
    if (cell && cell.dataset.date) {
      if (cell.classList.contains('res')) {
        query = ''; $('#q').value = '';
        cursor = parse(cell.dataset.date);
      }
      openEditor(cell.dataset.date);
      if (cell.classList.contains('res')) render();
      return;
    }

    const seg = e.target.closest('.segbtn');
    if (seg) { view = seg.dataset.view; render(); return; }

    const fs = e.target.closest('.fsbtns button');
    if (fs) { applyFontScale(fs.dataset.fs); return; }

    const tag = e.target.closest('.tag');
    if (tag && selected) {
      $$('.tag').forEach((t) => t.classList.toggle('is-on', t === tag));
      setDay(selected, $('#edText').value, tag.dataset.tag);
      persist(true);
      refreshCell(selected);
      return;
    }

    // 메뉴 밖을 클릭하면 닫기
    const menu = $('.menu');
    if (menu.open && !e.target.closest('.menu')) menu.open = false;
  });

  $('#btnPrev').onclick = () => step(-1);
  $('#btnNext').onclick = () => step(1);
  $('#btnToday').onclick = () => { cursor = new Date(); render(); };
  $('#edClose').onclick = closeEditor;
  $('#scrim').onclick = closeEditor;

  $('#edText').addEventListener('input', () => {
    if (!selected) return;
    setDay(selected, $('#edText').value, currentTag());
    refreshCell(selected);
  });

  $('#edFsDown').onclick = () => applyEdFont(edFont() - EDFS_STEP);
  $('#edFsUp').onclick = () => applyEdFont(edFont() + EDFS_STEP);
  $('#edFsVal').onclick = () => applyEdFont(1);

  // ---------- 체크박스 ----------
  // 메모는 평범한 글자라 네모 상자도 글자(☐ ☑)로 넣는다. 그래야 달력 칸·검색·엑셀·동기화에
  // 그대로 실려 간다. 상자를 누르면 ☐ ↔ ☑ 로 바뀐다.
  const BOX = '☐', CHECKED = '☑';
  const BOX_RE = /^(\s*)([☐☑]) ?/;

  /* 글자를 바꾸되 되돌리기(Ctrl+Z)가 살아 있도록 가능하면 insertText 를 쓴다.
     insertText 는 input 이벤트를 일으켜 저장까지 이어진다. 안 되는 브라우저에서는 직접 저장한다. */
  function replaceText(ta, a, b, text, selA, selB) {
    ta.focus();
    ta.setSelectionRange(a, b);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { /* 아래에서 대신 넣는다 */ }
    if (!ok || ta.value.slice(a, a + text.length) !== text) {
      ta.setRangeText(text, a, b, 'end');
      if (selected) { setDay(selected, ta.value, currentTag()); refreshCell(selected); }
    }
    ta.setSelectionRange(selA, selB);
  }

  /** 커서가 있는 줄(여러 줄을 골랐으면 그 줄들)에 상자를 붙이거나, 이미 다 붙어 있으면 뗀다 */
  function toggleBoxes() {
    const ta = $('#edText');
    const v = ta.value;
    const s0 = ta.selectionStart, s1 = ta.selectionEnd;
    const a = v.lastIndexOf('\n', s0 - 1) + 1;
    let b = v.indexOf('\n', s1 > s0 && v[s1 - 1] === '\n' ? s1 - 1 : s1);
    if (b < 0) b = v.length;

    const lines = v.slice(a, b).split('\n');
    const filled = lines.filter((l) => l.trim());
    const remove = filled.length > 0 && filled.every((l) => BOX_RE.test(l));
    const out = lines.map((l) => {
      if (remove) return l.replace(BOX_RE, '$1');
      if (BOX_RE.test(l) || (lines.length > 1 && !l.trim())) return l;   // 여러 줄일 때 빈 줄은 건너뛴다
      return l.replace(/^(\s*)/, `$1${BOX} `);
    }).join('\n');

    if (lines.length === 1) {
      const caret = Math.max(a, s0 + out.length - (b - a));             // 커서는 같은 글자 뒤에 둔다
      replaceText(ta, a, b, out, caret, caret);
    } else {
      replaceText(ta, a, b, out, a, a + out.length);
    }
  }

  $('#edCheck').onclick = toggleBoxes;

  // 상자 위를 누르면 체크/해제한다. 상자 바로 앞이나 뒤에 커서가 놓인 경우만 상자를 누른 것으로 본다
  $('#edText').addEventListener('click', () => {
    const ta = $('#edText');
    if (ta.selectionStart !== ta.selectionEnd) return;
    const v = ta.value, pos = ta.selectionStart;
    const a = v.lastIndexOf('\n', pos - 1) + 1;
    const m = BOX_RE.exec(v.slice(a, a + 8));
    if (!m) return;
    const at = a + m[1].length;                       // 상자 글자의 위치
    if (pos !== at && pos !== at + 1) return;
    const next = m[2] === BOX ? CHECKED : BOX;
    replaceText(ta, at, at + 1, next, at + 2, at + 2);
  });

  // 상자 줄에서 Enter 를 치면 다음 줄에도 상자를 붙인다. 빈 상자 줄에서 치면 상자를 지운다
  $('#edText').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const ta = $('#edText');
    if (ta.selectionStart !== ta.selectionEnd) return;
    const v = ta.value, pos = ta.selectionStart;
    const a = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(a, pos);
    const m = BOX_RE.exec(line);
    if (!m) return;
    e.preventDefault();
    let end = v.indexOf('\n', pos);
    if (end < 0) end = v.length;
    if (!line.slice(m[0].length).trim() && !v.slice(pos, end).trim()) {
      replaceText(ta, a, pos, m[1], a + m[1].length, a + m[1].length);
    } else {
      const ins = `\n${m[1]}${BOX} `;
      replaceText(ta, pos, pos, ins, pos + ins.length, pos + ins.length);
    }
  });

  $('#edClear').onclick = () => {
    if (!selected) return;
    if (!confirm(`${fmtLong(selected)} 기록을 비울까요?`)) return;
    $('#edText').value = '';
    setDay(selected, '', '');
    persist(true);
    $$('.tag').forEach((t) => t.classList.toggle('is-on', t.dataset.tag === ''));
    refreshCell(selected);
  };

  $('#q').addEventListener('input', (e) => { query = e.target.value; render(); });

  $('#syncChip').onclick = openSyncDialog;
  $('#btnSync').onclick = () => { $('.menu').open = false; openSyncDialog(); };
  $('#btnSyncNow').onclick = () => { $('.menu').open = false; syncNow(true); };

  $('#syncSave').onclick = async (e) => {
    e.preventDefault();
    const repo = $('#syncRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    const token = $('#syncToken').value.trim();
    const msg = $('#syncMsg');

    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      msg.hidden = false; msg.className = 'msg bad';
      msg.textContent = '저장소는 kimchul123/cal-data 처럼 "계정/저장소" 형태로 적어 주세요.';
      return;
    }
    if (!token) {
      msg.hidden = false; msg.className = 'msg bad';
      msg.textContent = '액세스 토큰을 넣어 주세요.';
      return;
    }

    sync.repo = repo;
    sync.token = token;
    saveSync();

    msg.hidden = false; msg.className = 'msg';
    msg.textContent = '연결을 확인하는 중…';
    await syncNow(false);

    if ($('#syncChip').dataset.state === 'ok') {
      msg.className = 'msg good';
      msg.textContent = `연결됐습니다. 이제 이 브라우저는 ${repo} 와 자동으로 기록을 주고받습니다.`;
    } else {
      msg.className = 'msg bad';
      msg.textContent = `연결하지 못했습니다 — ${$('#syncText').textContent}. 저장소 이름과 토큰 권한을 확인해 주세요.`;
    }
  };

  $('#syncOff').onclick = (e) => {
    e.preventDefault();
    if (!confirm('이 브라우저의 동기화를 끄고 토큰을 지웁니다.\n기록 자체는 그대로 남습니다. 계속할까요?')) return;
    sync = { repo: '', token: '', path: 'diary.json' };
    try { localStorage.removeItem(SYNC_KEY); } catch { /* 지울 게 없으면 그만이다 */ }
    setSyncState('off');
    $('#dlgSync').close();
  };

  $('#btnExport').onclick = () => { $('.menu').open = false; doExport(); };
  $('#btnXlsx').onclick = () => { $('.menu').open = false; doExportXlsx(); };
  $('#btnImport').onclick = () => { $('.menu').open = false; $('#fileIn').click(); };
  $('#btnStats').onclick = () => { $('.menu').open = false; showStats(); };
  $('#fileIn').addEventListener('change', (e) => {
    if (e.target.files[0]) doImport(e.target.files[0]);
    e.target.value = '';
  });

  $('#btnWipe').onclick = () => {
    $('.menu').open = false;
    if (!confirm('모든 기록을 지웁니다. 되돌릴 수 없습니다.\n먼저 JSON 내보내기로 백업하셨나요?')) return;
    if (!confirm('정말 전부 지울까요?')) return;
    store = { version: 2, days: {}, weeks: {}, todos: {} };
    persist(true);
    closeEditor();
    render();
  };

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

    if (e.key === 'Escape') {
      if (!$('#editor').hidden) { closeEditor(); return; }
      if (query) { query = ''; $('#q').value = ''; render(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); persist(true); return; }
    // 메모를 쓰는 중에는 Ctrl +/- 가 화면 전체 대신 메모 글자만 키운다
    if ((e.ctrlKey || e.metaKey) && e.target.id === 'edText' && /^[=+\-_0]$/.test(e.key)) {
      e.preventDefault();
      if (e.key === '0') applyEdFont(1);
      else applyEdFont(edFont() + (e.key === '-' || e.key === '_' ? -EDFS_STEP : EDFS_STEP));
      return;
    }
    if (typing) return;

    if (e.key === 'ArrowLeft') { step(-1); }
    else if (e.key === 'ArrowRight') { step(1); }
    else if (e.key === 't' || e.key === 'ㅅ') { cursor = new Date(); render(); }
    else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  });

  // 저장할 게 없으면 쓰지 않는다. 탭을 두 개 열었을 때 오래된 사본으로 덮어쓰는 것을 막는다
  window.addEventListener('beforeunload', () => { if (dirty) persist(true); });

  // 다른 PC 에서 쓴 내용을 받아오는 시점: 창을 다시 볼 때, 그리고 방금 고쳤을 때
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync();
  });
  window.addEventListener('online', () => scheduleSync());

  // 다른 탭에서 기록이 바뀌면 이 탭도 따라간다 (편집 중이면 건드리지 않는다)
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || dirty || selected) return;
    if (tdOpenId && tdDirty) return;          // 다른 탭 내용으로 지금 쓰는 글을 밀어내지 않는다
    load();
    refreshOpenTodo();
    if (!tdOpenId) render();
  });

  // 주소의 #2026-09-25 형태로 특정 날짜를 바로 연다 (뒤로가기·링크 공유용)
  function openFromHash() {
    const h = location.hash.slice(1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) return false;
    cursor = parse(h);
    render();
    openEditor(h);
    return true;
  }

  window.addEventListener('hashchange', () => {
    if (!openFromHash() && selected) closeEditor();
  });

  // ---------- boot ----------
  loadFontScale();
  loadEdWidth();
  loadEdFont();
  load();
  loadSync();
  setSyncState(syncOn() ? 'ok' : 'off', syncOn() ? '대기 중' : '');
  if (!openFromHash()) render();
  if (syncOn()) syncNow(false);
})();
