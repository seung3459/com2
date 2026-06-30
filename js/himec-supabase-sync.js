/* =====================================================================
 * HIMEC · localStorage ⇆ Supabase(app_state) 동기화 어댑터  [v4]
 * ---------------------------------------------------------------------
 * v4 변경점 (PC ↔ 모바일 동일 노출):
 *   1) 복원(hydrate) 완료 전에는 클라우드 미러링을 보류 → 새 기기의
 *      "빈 기본값 자동저장"이 클라우드를 덮어쓰는 사고 차단.
 *   2) 복원 완료 시 'himec:hydrated' 이벤트 발생 + whenHydrated() 제공
 *      → 각 페이지가 이 신호를 받아 메모리를 다시 읽고 재렌더 가능.
 *   3) 복원 정책을 "로컬이 비었을 때만"에서 "클라우드가 더 최신이면
 *      가져오기"로 강화 → 이미 빈 값으로 덮인 기기도 복구.
 *      (각 키의 클라우드 updated_at 을 로컬 기준선 '<key>__cts' 와 비교)
 *
 * 단일 작성자 가정(한 프로젝트=한 담당) 하에서 동작. 동시 편집 충돌
 * 처리는 후속 단계(별도)에서 추가.
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
  var HYDRATE_TIMEOUT_MS = 5000;   // 이 시간 안에 복원 못 끝내면 화면은 풀어줌

  function log()  { if (CFG.DEBUG && w.console) console.log.apply(console, ['[himec-sync]'].concat([].slice.call(arguments))); }
  function warn() { if (w.console) console.warn.apply(console, ['[himec-sync]'].concat([].slice.call(arguments))); }

  /* --- 원본 localStorage 메서드 보존(재귀/루프 방지) --- */
  var _ls = w.localStorage;
  var _origSet    = _ls.setItem.bind(_ls);
  var _origGet    = _ls.getItem.bind(_ls);
  var _origRemove = _ls.removeItem.bind(_ls);

  /* --- 복원 완료 게이트 --- */
  var hydrated = false;
  var _hydrateResolve;
  var hydratedPromise = new Promise(function (res) { _hydrateResolve = res; });
  function markHydrated() {
    if (hydrated) return;
    hydrated = true;
    try { _hydrateResolve(); } catch (e) {}
    try { w.dispatchEvent(new Event('himec:hydrated')); } catch (e) {
      // 구형 브라우저 폴백
      try { var ev = d.createEvent('Event'); ev.initEvent('himec:hydrated', true, true); w.dispatchEvent(ev); } catch (e2) {}
    }
    log('hydrated → mirroring enabled, event fired');
    // 복원 전 보류 구간에 쌓였을 수 있는 로컬 변경을 한 번 밀어올림
    try { w.HIMEC_SYNC.syncNow(); } catch (e) {}
  }

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
    'gh_file_data/projects.json': 1, 'himec_tool_projects': 1, 'himec_tool_results': 1,
    'HIMEC_SUMMARY_STATE': 1, 'HIMEC_SUBJECT_NOTES': 1, 'HIMEC_SUBJECT_ETC': 1,
    'HIMEC_CHILLER_SAVE': 1
  };
  function isTracked(key) {
    if (!key) return false;
    if (key === 'activeProjectId') return false;
    if (key.indexOf('__cts') === key.length - 5 && key.length > 5) return false; // 기준선 메타키 제외
    if (EXACT_KEYS[key]) return true;
    if (key.indexOf('HIMEC_SAVE::') === 0) return true;
    if (/^std_[^_]+_/.test(key)) return true;
    return false;
  }
  // localStorage 키 → app_state.key
  function toStateKey(lsKey) {
    if (lsKey === 'himec_pm_tool_v23') return 'manage';
    if (lsKey === 'HIMEC_SAVE_DATA')   return 'diagnosis_' + (activeProjectId() || 'default');
    return lsKey;
  }
  // app_state.key → localStorage 키 (복원용 역매핑)
  function toLocalKey(stateKey) {
    if (stateKey === 'manage') return 'himec_pm_tool_v23';
    // diagnosis_* 는 diagnosis.html 자체 로직이 담당 → 여기선 건드리지 않음
    if (stateKey.indexOf('diagnosis_') === 0) return null;
    if (!isTracked(stateKey)) return null;
    return stateKey;
  }

  /* --- 비어있음 판정(전환기 1회용): 클라우드로 덮을지 결정 --- */
  function isEmptyVal(lsKey, val) {
    if (val == null) return true;
    if (typeof val === 'object' && '__raw' in val && Object.keys(val).length === 1)
      return String(val.__raw).trim() === '';
    if (lsKey === 'himec_pm_tool_v23') {
      var s1 = val.s1 || {}, hasS1 = Object.keys(s1).some(function (y) { return (s1[y] || []).length; });
      return !hasS1 && !((val.carry || []).length) && !((val.newp || []).length);
    }
    if (lsKey === 'gh_file_data/projects.json') {
      var arr = (val && val.projects) ? val.projects : (Array.isArray(val) ? val : []);
      return !arr.length;
    }
    if (Array.isArray(val)) return val.length === 0;
    if (typeof val === 'object') return Object.keys(val).length === 0;
    return String(val).trim() === '';
  }

  /* ---------------------------------------------------------------
   * 쓰기: 디바운스 upsert → app_state  (복원 전엔 보류)
   * --------------------------------------------------------------- */
  var _timers = {};
  function scheduleMirror(lsKey, rawValue) {
    if (!isTracked(lsKey)) return;
    if (!hydrated) { log('mirror 보류(복원 전):', lsKey); return; } // ★ 클로버 방지 핵심
    clearTimeout(_timers[lsKey]);
    _timers[lsKey] = setTimeout(function () {
      var stateKey = toStateKey(lsKey);
      var parsed = jparse(rawValue, null);
      var dataVal = (parsed !== null) ? parsed : { __raw: String(rawValue) };
      var ts = nowIso();
      withClient(function (client) {
        log('mirror →', lsKey, '⇒ app_state[' + stateKey + ']');
        return client.from(TABLE).upsert(
          { key: stateKey, data: dataVal, updated_at: ts },
          { onConflict: 'key' }
        ).then(function (r) {
          if (r && r.error) warn('upsert err', stateKey, r.error.message || r.error);
          else { try { _origSet(stateKey + '__cts', ts); } catch (e) {} } // 기준선 갱신
        });
      });
    }, DEBOUNCE);
  }

  /* --- localStorage 후킹 --- */
  try {
    _ls.setItem = function (key, value) {
      _origSet(key, value);
      try { scheduleMirror(key, value); } catch (e) { warn('mirror sched fail', e); }
    };
    _ls.removeItem = function (key) { _origRemove(key); };
  } catch (e) { warn('hook install fail', e); }

  /* ---------------------------------------------------------------
   * 복원: 클라우드가 더 최신이면 로컬을 교체
   * --------------------------------------------------------------- */
  function fromState(dataVal) {
    if (dataVal && typeof dataVal === 'object' && '__raw' in dataVal && Object.keys(dataVal).length === 1)
      return dataVal.__raw;
    return JSON.stringify(dataVal);
  }
  function hydrate() {
    if (!HYDRATE) { markHydrated(); return; }
    var done = false;
    var safety = setTimeout(function () { if (!done) { warn('hydrate timeout'); markHydrated(); } }, HYDRATE_TIMEOUT_MS);

    withClient(function (client) {
      return client.from(TABLE).select('key,data,updated_at').then(function (r) {
        if (r && r.error) { warn('hydrate select err', r.error.message || r.error); return; }
        var rows = (r && r.data) || [];
        rows.forEach(function (row) {
          var lsKey = toLocalKey(row.key);
          if (!lsKey) return;                      // diagnosis_* 등은 스킵

          var cloudTs = row.updated_at || '';
          var baseTs  = null;
          try { baseTs = _origGet(row.key + '__cts'); } catch (e) {}

          var take = false;
          if (baseTs) {
            // 기준선 있음 → 클라우드가 더 최신일 때만 가져옴
            take = cloudTs > baseTs;
          } else {
            // 기준선 없음(전환기) → 로컬이 비어있고 클라우드가 내용 있으면 가져옴
            var localRaw = null;
            try { localRaw = _origGet(lsKey); } catch (e) {}
            var localVal = (localRaw == null) ? null : jparse(localRaw, { __raw: localRaw });
            var localEmpty = (localRaw == null) || isEmptyVal(lsKey, localVal);
            var cloudEmpty = isEmptyVal(lsKey, row.data);
            take = localEmpty && !cloudEmpty;
          }

          if (take) {
            try { _origSet(lsKey, fromState(row.data)); log('hydrated ←', lsKey); } catch (e) {}
          }
          // 다음 비교를 위해 기준선을 클라우드 ts 로 정렬(가져왔든 유지했든)
          try { if (cloudTs) _origSet(row.key + '__cts', cloudTs); } catch (e) {}
        });
      });
    }).then(function () {
      done = true; clearTimeout(safety); markHydrated();
    }).catch(function (e) {
      warn('hydrate fail', e); done = true; clearTimeout(safety); markHydrated();
    });
  }

  /* ---------------------------------------------------------------
   * 부팅 + 외부 핸들
   * --------------------------------------------------------------- */
  function boot() {
    if (!ENABLED) { log('sync disabled'); markHydrated(); return; }
    sbReady.then(function (c) { if (c) hydrate(); else markHydrated(); });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();

  w.HIMEC_SYNC = {
    isEnabled: function () { return ENABLED; },
    ready: function () { return sbReady; },
    isHydrated: function () { return hydrated; },
    whenHydrated: function () { return hydratedPromise; },
    mirrorKey: function (k) { scheduleMirror(k, _origGet(k)); },
    syncNow: function () {
      try {
        for (var i = 0; i < _ls.length; i++) {
          var k = _ls.key(i);
          if (k && isTracked(k)) scheduleMirror(k, _origGet(k));
        }
      } catch (e) { warn('syncNow fail', e); }
    },
    loadToolRegistry: function () { return Promise.resolve(null); },
    backupNow: function () {}
  };
})(window, document);
