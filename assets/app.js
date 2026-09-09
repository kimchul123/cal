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
  let store = { version: 2, days: {}, weeks: {} };
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
    $$('.segbtn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === view));

    const searching = query.trim().length > 0;
    $('#viewMonth').hidden = searching || view !== 'month';
    $('#viewWeek').hidden = searching || view !== 'week';
    $('#viewSearch').hidden = !searching;

    if (searching) { renderSearch(); return; }
    if (view === 'month') renderMonth(); else renderWeek();
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
    if (window.matchMedia('(max-width: 620px)').matches) $('#scrim').hidden = false;
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
    $('#scrim').hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    render();
  }

  function currentTag() {
    const on = $('.tag.is-on');
    return on ? on.dataset.tag : '';
  }

  // ---------- import / export ----------
  function doExport() {
    const payload = {
      version: 1,
      app: 'kimchul123/cal',
      exportedAt: new Date().toISOString(),
      days: store.days,
      weeks: store.weeks,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `calendar-backup-${todayISO()}.json`;
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
      for (const k of Object.keys(normMap(days))) store.days[k].t = now;
      for (const k of Object.keys(normMap(o.weeks))) store.weeks[k].t = now;

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

  const fingerprint = (m) =>
    Object.keys(m).sort().map((k) => `${k}:${m[k].t}:${m[k].text.length}:${m[k].tag}`).join('|');

  async function syncNow(manual) {
    if (!syncOn()) { if (manual) openSyncDialog(); return; }
    if (syncing) return;
    syncing = true;
    setSyncState('syncing');

    try {
      const file = await gh('GET');
      let remote = { days: {}, weeks: {} };
      if (file) {
        const raw = await fileContent(file);
        let o;
        try { o = JSON.parse(raw); }
        catch { throw new Error(`${sync.path} 을 읽지 못했습니다 (JSON 형식 오류)`); }
        remote = { days: normMap(o.days), weeks: normMap(o.weeks) };
      }

      const before = fingerprint(store.days) + '#' + fingerprint(store.weeks);
      const pulled = mergeInto(store.days, remote.days) | mergeInto(store.weeks, remote.weeks);
      const after = fingerprint(store.days) + '#' + fingerprint(store.weeks);

      if (pulled) { persist(true); if (!selected) render(); }

      const remoteFp = fingerprint(remote.days) + '#' + fingerprint(remote.weeks);
      if (after !== remoteFp) {
        const payload = {
          version: 2,
          app: 'kimchul123/cal',
          updatedAt: new Date().toISOString(),
          days: store.days,
          weeks: store.weeks,
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
  function step(dir) {
    if (view === 'month') {
      // 31일에서 setMonth 를 쓰면 다음 달을 건너뛰므로 항상 1일 기준으로 옮긴다
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
    } else {
      cursor = addDays(cursor, 7 * dir);
    }
    render();
  }

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

  $('#edTemplate').onclick = () => {
    const ta = $('#edText');
    const base = ta.value.replace(/\s+$/, '');
    ta.value = (base ? base + '\n' : '') + '1\n2\n3\n4\n5\n6';
    ta.focus();
    if (selected) { setDay(selected, ta.value, currentTag()); persist(true); }
  };

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
    store = { version: 1, days: {}, weeks: {} };
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
    load();
    render();
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
  load();
  loadSync();
  setSyncState(syncOn() ? 'ok' : 'off', syncOn() ? '대기 중' : '');
  if (!openFromHash()) render();
  if (syncOn()) syncNow(false);
})();
