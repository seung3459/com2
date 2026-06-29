/* =====================================================================
 * HIMEC · localStorage ⇆ Supabase(app_state) 동기화 어댑터  [v3]
 * ---------------------------------------------------------------------
 * 목적 : 기존 화면(JS/UI)을 일절 건드리지 않고 "Local → Local + Cloud".
 * 방식 : localStorage.setItem 을 가로채(monkey-patch) 추적 대상 키를
 *        public.app_state (key PK / data jsonb / updated_at) 한 곳으로
 *        upsert 미러링한다. 페이지 진입 시 로컬이 비어 있으면 app_state
 *        에서 1회 복원한다.
 *
 * ▣ 왜 app_state 인가
 *   - 이 프로젝트의 라이브 DB에 실제로 존재하고, anon 쓰기 정책
 *     (temp anon all)이 허용된 유일한 범용 저장소이기 때문.
 *   - 기존에 'manage', 'diagnosis_<projectId>' 가 이미 이 방식으로
 *     저장돼 있어 규칙을 그대로 잇는다.
 *
 * ▣ localStorage 키 → app_state.key 매핑
 *   himec_pm_tool_v23           → 'manage'
 *   HIMEC_SAVE_DATA             → 'diagnosis_<activeProjectId|default>'
 *   HIMEC_SAVE::<경로>          → (그대로)   ← Tool-201/202/204/303/304 …
 *   HIMEC_CHILLER_SAVE          → (그대로)   ← Tool-201
 *   std_<tool>_<pid>            → (그대로)
 *   himec_metrics               → (그대로)
 *   gh_file_data/projects.json  → (그대로)
 *   himec_tool_projects         → (그대로)
 *   HIMEC_SUMMARY_STATE/…NOTES/…ETC → (그대로)
 *   activeProjectId             → 제외(세션값). 단 diagnosis 키 산정에 사용.
 *
 * ※ 이 파일은 저장소 계층만 담당. UI/계산 로직은 변경하지 않음.
 *   드롭인 교체: 경로(/js/himec-supabase-sync.js)·로드 순서 동일.
 * ===================================================================== */
(function (w, d) {
  'use strict';
  if (w.__HIMEC_SYNC_INSTALLED) return;
  w.__HIMEC_SYNC_INSTALLED = true;

  var CFG = w.HIMEC_SUPABASE_CONFIG || {};
  var ENABLED = CFG.ENABLE_SYNC !== false &&
                CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR-') === -1;
  var DEBOUNCE = CFG.WRITE_DEBOUNCE_MS || 1500;
  var HYDRATE  = CFG.HYDRATE_ON_EMPTY !== false;
  var TABLE    = 'app_state';

  function log()  { if (CFG.DEBUG && w.console) console.log.apply(console, ['[himec-sync]'].concat([].slice.call(arguments))); }
  function warn() { if (w.console) console.warn.apply(console, ['[himec-sync]'].concat([].slice.call(arguments))); }

  /* --- 원본 localStorage 메서드 보존(재귀/루프 방지) --- */
  var _ls = w.localStorage;
  var _origSet    = _ls.setItem.bind(_ls);
  var _origGet    = _ls.getItem.bind(_ls);
  var _origRemove = _ls.removeItem.bind(_ls);

  /* --- Supabase 클라이언트 비동기 로드 --- */
  var sb = null;
  var sbReady = new Promise(function (resolve) {
    if (!ENABLED) { resolve(null); return; }
    function init() {
      try {
        sb = w.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true }
        });
        log('client ready'); resolve(sb);
      } catch (e) { warn('client init fail', e); resolve(null); }
    }
    if (w.supabase && w.supabase.createClient) { init(); return; }
    var s = d.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.async = true; s.onload = init;
    s.onerror = function () { warn('supabase-js CDN load failed; Local-only'); resolve(null); };
    d.head.appendChild(s);
  });
  function withClient(fn) {
    return sbReady.then(function (c) { return c ? fn(c) : null; })
                  .catch(function (e) { warn('op error', e); return null; });
  }

  /* --- 유틸 --- */
  function jparse(s, fb) { try { return JSON.parse(s); } catch (e) { return fb; } }
  function nowIso() { return new Date().toISOString(); }
  function activeProjectId() {
    try { return _origGet('activeProjectId') || null; } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------
   * 추적 대상 판별 + app_state.key 매핑
   * --------------------------------------------------------------- */
  var EXACT_KEYS = {
    'himec_pm_tool_v23': 1, 'HIMEC_SAVE_DATA': 1, 'himec_metrics': 1,
    'gh_file_data/projects.json': 1, 'himec_tool_projects': 1,
    'HIMEC_SUMMARY_STATE': 1, 'HIMEC_SUBJECT_NOTES': 1, 'HIMEC_SUBJECT_ETC': 1,
    'HIMEC_CHILLER_SAVE': 1
  };
  function isTracked(key) {
    if (key === 'activeProjectId') return false;
    if (EXACT_KEYS[key]) return true;
    if (key.indexOf('HIMEC_SAVE::') === 0) return true;   // 범용 도구(202/204/303/304…)
    if (/^std_[^_]+_/.test(key)) return true;             // 개별 도구 실행 결과
    return false;
  }
  // localStorage 키 → app_state.key
  function toStateKey(lsKey) {
    if (lsKey === 'himec_pm_tool_v23') return 'manage';
    if (lsKey === 'HIMEC_SAVE_DATA')   return 'diagnosis_' + (activeProjectId() || 'default');
    return lsKey; // 그 외는 그대로
  }

  /* ---------------------------------------------------------------
   * 쓰기: 디바운스 upsert → app_state
   * --------------------------------------------------------------- */
  var _timers = {};
  function scheduleMirror(lsKey, rawValue) {
    if (!isTracked(lsKey)) return;
    clearTimeout(_timers[lsKey]);
    _timers[lsKey] = setTimeout(function () {
      var stateKey = toStateKey(lsKey);
      var parsed = jparse(rawValue, null);
      var dataVal = (parsed !== null) ? parsed : { __raw: String(rawValue) };
      withClient(function (client) {
        log('mirror →', lsKey, '⇒ app_state[' + stateKey + ']');
        return client.from(TABLE).upsert(
          { key: stateKey, data: dataVal, updated_at: nowIso() },
          { onConflict: 'key' }
        ).then(function (r) {
          if (r && r.error) warn('upsert err', stateKey, r.error.message || r.error);
        });
      });
    }, DEBOUNCE);
  }

  /* ---------------------------------------------------------------
   * localStorage 후킹 (로컬 우선 저장 → 그 후 클라우드 미러)
   * --------------------------------------------------------------- */
  try {
    _ls.setItem = function (key, value) {
      _origSet(key, value);
      try { scheduleMirror(key, value); } catch (e) { warn('mirror sched fail', e); }
    };
    _ls.removeItem = function (key) {
      _origRemove(key); // 삭제 미러는 데이터 유실 위험으로 기본 비활성
    };
  } catch (e) { warn('hook install fail', e); }

  /* ---------------------------------------------------------------
   * 복원: 로컬이 빈 키에 한해 app_state 에서 1회 채움
   *   - app_state 전체(소량)를 한 번 읽어 역매핑으로 복원
   *   - 복원 시 _origSet 사용(미러 루프 방지)
   *   ※ 도구 페이지가 자체 로드에서 localStorage 를 먼저 읽으므로,
   *     완전히 새 기기 첫 접속 시에는 복원 직후 새로고침 1회가 필요할 수 있음.
   * --------------------------------------------------------------- */
  function fromState(dataVal) {
    if (dataVal && typeof dataVal === 'object' && '__raw' in dataVal && Object.keys(dataVal).length === 1)
      return dataVal.__raw;            // 원시 문자열로 저장됐던 값
    return JSON.stringify(dataVal);
  }
  function hydrate() {
    if (!HYDRATE) return;
    withClient(function (client) {
      return client.from(TABLE).select('key,data').then(function (r) {
        if (!r || !r.data || !r.data.length) return;
        var rows = r.data, byKey = {};
        rows.forEach(function (row) { byKey[row.key] = row.data; });

        // 1) 고정 매핑 키 복원 (로컬이 비어 있을 때만)
        if (!_origGet('himec_pm_tool_v23') && byKey['manage'] != null)
          _origSet('himec_pm_tool_v23', fromState(byKey['manage']));

        if (!_origGet('HIMEC_SAVE_DATA')) {
          var dk = 'diagnosis_' + (activeProjectId() || 'default');
          if (byKey[dk] != null) _origSet('HIMEC_SAVE_DATA', fromState(byKey[dk]));
        }

        // 2) 그대로-매핑 키 복원 (고정/패턴 모두 동일 키명)
        rows.forEach(function (row) {
          var k = row.key;
          if (k === 'manage' || k.indexOf('diagnosis_') === 0) return; // 위에서 처리
          if (!isTracked(k)) return;            // app_state 의 다른 데이터는 건드리지 않음
          if (_origGet(k) != null) return;      // 로컬에 이미 있으면 보존
          _origSet(k, fromState(row.data));
          log('hydrated ←', k);
        });
      });
    });
  }

  /* ---------------------------------------------------------------
   * 부팅 + 외부 핸들
   * --------------------------------------------------------------- */
  function boot() {
    if (!ENABLED) { log('sync disabled'); return; }
    sbReady.then(function (c) { if (c) hydrate(); });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();

  w.HIMEC_SYNC = {
    isEnabled: function () { return ENABLED; },
    ready: function () { return sbReady; },
    // 특정 키를 지금 즉시 미러(디바운스 후 실행)
    mirrorKey: function (k) { scheduleMirror(k, _origGet(k)); },
    // 추적 대상 전체를 한 번에 미러
    syncNow: function () {
      try {
        for (var i = 0; i < _ls.length; i++) {
          var k = _ls.key(i);
          if (k && isTracked(k)) scheduleMirror(k, _origGet(k));
        }
      } catch (e) { warn('syncNow fail', e); }
    },
    // 구버전 대시보드 호환: 클라우드 레지스트리 미사용 → null(=localStorage 폴백)
    loadToolRegistry: function () { return Promise.resolve(null); },
    backupNow: function () {}  // 구버전 호환 no-op (app_state 행 자체가 백업을 대체)
  };
})(window, document);
