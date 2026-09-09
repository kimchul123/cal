/* 대한민국 공휴일 표
 *
 * - 양력 고정 공휴일은 FIXED 에서 자동 계산됩니다.
 * - 음력 기준 공휴일(설날·추석·부처님오신날)은 해마다 날짜가 달라 아래 표에 직접 적습니다.
 *   설날/추석은 "당일"만 적으면 앞뒤 하루씩 연휴로 자동 확장됩니다.
 * - 대체공휴일은 해마다 정부 지정이 달라 자동 계산하지 않습니다.
 *   필요하면 EXTRA 에 직접 추가하세요.
 *
 * ※ 2028년 이후 음력 공휴일을 쓰려면 LUNAR 표에 해당 연도를 추가해야 합니다.
 */

const FIXED = {
  '01-01': '신정',
  '03-01': '삼일절',
  '05-05': '어린이날',
  '06-06': '현충일',
  '08-15': '광복절',
  '10-03': '개천절',
  '10-09': '한글날',
  '12-25': '크리스마스',
};

const LUNAR = {
  //        설날 당일       추석 당일       부처님오신날
  2018: ['2018-02-16', '2018-09-24', '2018-05-22'],
  2019: ['2019-02-05', '2019-09-13', '2019-05-12'],
  2020: ['2020-01-25', '2020-10-01', '2020-04-30'],
  2021: ['2021-02-12', '2021-09-21', '2021-05-19'],
  2022: ['2022-02-01', '2022-09-10', '2022-05-08'],
  2023: ['2023-01-22', '2023-09-29', '2023-05-27'],
  2024: ['2024-02-10', '2024-09-17', '2024-05-15'],
  2025: ['2025-01-29', '2025-10-06', '2025-05-05'],
  2026: ['2026-02-17', '2026-09-25', '2026-05-24'],
  2027: ['2027-02-07', '2027-09-15', '2027-05-13'],
};

/* 대체공휴일 등 직접 추가하고 싶은 날 */
const EXTRA = {
  // '2026-03-02': '대체공휴일',
};

const _cache = {};

function shift(iso, days) {
  // toISOString 은 UTC 로 바꾸므로 KST(+9)에서 하루씩 밀린다. 지역 날짜로 직접 조립한다.
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 해당 연도의 { 'YYYY-MM-DD': '공휴일명' } 맵 */
function holidaysOf(year) {
  if (_cache[year]) return _cache[year];
  const map = {};

  for (const [md, name] of Object.entries(FIXED)) map[`${year}-${md}`] = name;

  const lun = LUNAR[year];
  if (lun) {
    const [seol, chuseok, buddha] = lun;
    map[shift(seol, -1)] = '설날 연휴';
    map[seol] = '설날';
    map[shift(seol, 1)] = '설날 연휴';
    map[shift(chuseok, -1)] = '추석 연휴';
    map[chuseok] = '추석';
    map[shift(chuseok, 1)] = '추석 연휴';
    map[buddha] = '부처님오신날';
  }

  for (const [iso, name] of Object.entries(EXTRA)) {
    if (iso.startsWith(String(year))) map[iso] = name;
  }

  _cache[year] = map;
  return map;
}

/** 특정 날짜의 공휴일명 (없으면 null) */
window.holidayName = function (iso) {
  return holidaysOf(Number(iso.slice(0, 4)))[iso] || null;
};
