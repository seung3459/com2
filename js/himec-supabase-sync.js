/* =====================================================================
 * HIMEC · localStorage ⇆ Supabase 동기화 어댑터
 * ---------------------------------------------------------------------
 * 목적 : 기존 화면(JS/UI)을 건드리지 않고 "Local → Local + Supabase".
 * 방식 : localStorage.setItem/removeItem 을 가로채(monkey-patch) 추적
 *        대상 6키를 DB 11테이블로 미러링한다. 기존 코드는 그대로
 *        localStorage 를 쓰면 되고, 클라우드 반영은 자동.
 *
 * 추적 키 → 테이블 매핑
 *   HIMEC_SAVE_DATA      → diagnoses + equipment_units + equipment_diag_items
 *   himec_pm_tool_v23    → pm_records (s1 / newp / carry)
 *   gh_file_data/projects.json → projects
 *   himec_tool_projects  → tool_runs (도구·프로젝트 레지스트리)
 *   himec_metrics        → diagnosis_results (+ projects 보강)
 *   std_<tool>_<pid>     → tool_runs (개별 도구 실행 결과, 패턴)
 *   activeProjectId      → 제외(세션값). 단 project sync_id 매칭에 사용.
 *
 * ※ 이 파일은 저장소 계층만 담당. UI/계산 로직은 일절 변경하지 않음.
 * ===================================================================== */
(function (w, d) {
  'use strict';
  if (w.__HIMEC_SYNC_INSTALLED) return;
  w.__HIMEC_SYNC_INSTALLED = true;

  var CFG = w.HIMEC_SUPABASE_CONFIG || {};
  var ENABLED = CFG.ENABLE_SYNC !== false &&
                CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR-') === -1;

  function log() {
    if (CFG.DEBUG && w.console) {
      var a = ['[himec-sync]'].concat([].slice.call(arguments));
      console.log.apply(console, a);
    }
  }
  function warn() {
    if (w.console) console.warn.apply(console, ['[himec-sync]'].concat([].slice.call(arguments)));
  }

  /* ---------------------------------------------------------------
   * 0. 원본 localStorage 메서드 보존 (재귀 호출 방지)
   * --------------------------------------------------------------- */
  var _ls = w.localStorage;
  var _origSet = _ls.setItem.bind(_ls);
  var _origRemove = _ls.removeItem.bind(_ls);
  var _origGet = _ls.getItem.bind(_ls);

  /* ---------------------------------------------------------------
   * 1. Supabase 클라이언트 비동기 로드
   * --------------------------------------------------------------- */
  var sb = null;
  var sbReady = (function () {
    return new Promise(function (resolve) {
      if (!ENABLED) { resolve(null); return; }
      function init() {
        try {
          sb = w.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true }
          });
          log('client ready');
          resolve(sb);
        } catch (e) { warn('client init fail', e); resolve(null); }
      }
      if (w.supabase && w.supabase.createClient) { init(); return; }
      var s = d.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.async = true;
      s.onload = init;
      s.onerror = function () { warn('supabase-js CDN load failed; Local-only mode'); resolve(null); };
      d.head.appendChild(s);
    });
  })();

  function withClient(fn) {
    return sbReady.then(function (client) { return client ? fn(client) : null; })
                  .catch(function (e) { warn('op error', e); return null; });
  }

  var companyId = (typeof w.himecCompanyId === 'function')
    ? w.himecCompanyId() : (CFG.DEFAULT_COMPANY_ID || null);

  /* ---------------------------------------------------------------
   * 2. 유틸
   * --------------------------------------------------------------- */
  function jparse(s, fb) { try { return JSON.parse(s); } catch (e) { return fb; } }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function nowIso() { return new Date().toISOString(); }

  // DB enum 허용값 — 목록에 없으면 보내지 않음(undefined) → 400 방지
  var STATUS_ENUM   = ['미계약', '계약', '수행', '종료'];
  var ACTIVITY_ENUM = ['노후진단', '에너지진단', 'TAB', '연구'];
  function enumOr(v, allowed) { return allowed.indexOf(v) !== -1 ? v : undefined; }

  // 프로젝트 sync_id → projects.id 캐시/조회/생성
  var _projCache = {};
  function resolveProject(client, syncId, fallbackName, year) {
    if (!syncId) return Promise.resolve(null);
    if (_projCache[syncId]) return Promise.resolve(_projCache[syncId]);
    return client.from('projects').select('id').eq('company_id', companyId)
      .eq('sync_id', syncId).limit(1).maybeSingle()
      .then(function (r) {
        if (r && r.data && r.data.id) { _projCache[syncId] = r.data.id; return r.data.id; }
        return client.from('projects').insert({
          company_id: companyId, sync_id: syncId,
          name: fallbackName || syncId, year: year || new Date().getFullYear()
        }).select('id').single().then(function (ins) {
          var id = ins && ins.data ? ins.data.id : null;
          if (id) _projCache[syncId] = id;
          return id;
        });
      })
      .catch(function () { return null; });
  }

  /* ---------------------------------------------------------------
   * 3. 키별 변환기(transform) — 각 키를 DB row 로
   *    "replace 시맨틱": 해당 데이터셋 scope 를 지우고 다시 넣어
   *    Local==Cloud 를 보장(테스트 단계에 가장 안전).
   * --------------------------------------------------------------- */

  // 3-1) himec_metrics → diagnosis_results (+ projects 보강)
  function syncMetrics(client, raw) {
    var o = jparse(raw, null); if (!o) return Promise.resolve();
    var results = Array.isArray(o.diagResults) ? o.diagResults : [];
    var rows = results.map(function (r) {
      return {
        company_id: companyId,
        project_id: null,            // 이름 기반, 매칭은 추후 트리거/뷰에서
        year: r.year != null ? parseInt(r.year, 10) : null,
        equip: String(r.equip || ''),
        first_grade: r.first || null,
        second_perf: r.second || null,
        result: r.result || null,
        perf: r.perf || null,
        subtotal: num(r.amount)
      };
    });
    return client.from('diagnosis_results').delete().eq('company_id', companyId)
      .then(function () {
        return rows.length ? chunkInsert(client, 'diagnosis_results', rows) : null;
      });
  }

  // 3-2) gh_file_data/projects.json → projects
  function syncProjects(client, raw) {
    var o = jparse(raw, null); if (!o) return Promise.resolve();
    var list = Array.isArray(o.projects) ? o.projects : (Array.isArray(o) ? o : []);
    var ops = list.map(function (p) {
      var syncId = String(p.id || p.sync_id || p.name || '');
      var rowName = p.name || syncId;
      return client.from('projects').select('id').eq('company_id', companyId)
        .eq('sync_id', syncId).limit(1).maybeSingle()
        .then(function (r) {
          var payload = {
            company_id: companyId, sync_id: syncId, name: rowName,
            year: p.year != null ? parseInt(p.year, 10) : new Date().getFullYear(),
            status: enumOr(p.status, STATUS_ENUM),
            activity: enumOr(p.activity, ACTIVITY_ENUM),
            fee: num(p.fee != null ? p.fee : p.amount),
            out_cost: num(p.out_cost),
            month: p.month != null ? parseInt(p.month, 10) : null
          };
          if (r && r.data && r.data.id) {
            return client.from('projects').update(payload).eq('id', r.data.id);
          }
          return client.from('projects').insert(payload);
        });
    });
    return Promise.all(ops);
  }

  // 3-3) himec_pm_tool_v23 → pm_records (s1/newp/carry)
  function syncPm(client, raw) {
    var S = jparse(raw, null); if (!S) return Promise.resolve();
    var rows = [];
    ['s1', 'newp', 'carry'].forEach(function (kind) {
      var arr = S[kind];
      if (!Array.isArray(arr)) return;
      arr.forEach(function (it) {
        rows.push({
          company_id: companyId,
          project_id: null,
          kind: kind,
          year: it.year != null ? parseInt(it.year, 10) : new Date().getFullYear(),
          name: it.name || null,
          fee: num(it.fee != null ? it.fee : it.amount),
          out_cost: num(it.out_cost != null ? it.out_cost : it.cost),
          status: enumOr(it.status, STATUS_ENUM) || null,
          month: it.month != null ? parseInt(it.month, 10) : null,
          payload: it
        });
      });
    });
    return client.from('pm_records').delete().eq('company_id', companyId)
      .then(function () { return rows.length ? chunkInsert(client, 'pm_records', rows) : null; });
  }

  // 3-4) himec_tool_projects → tool_runs (레지스트리: {toolId:[{id,name,year}]})
  function syncToolRegistry(client, raw) {
    var o = jparse(raw, {}); if (!o || typeof o !== 'object') return Promise.resolve();
    var rows = [];
    Object.keys(o).forEach(function (toolId) {
      var arr = Array.isArray(o[toolId]) ? o[toolId] : [];
      arr.forEach(function (p) {
        rows.push({
          company_id: companyId, project_id: null,
          tool_id: String(toolId),
          tool_category: 'registry',
          title: p.name || null,
          inputs: { project_id: p.id || null, year: p.year || null },
          results: p
        });
      });
    });
    return client.from('tool_runs').delete()
      .eq('company_id', companyId).eq('tool_category', 'registry')
      .then(function () { return rows.length ? chunkInsert(client, 'tool_runs', rows) : null; });
  }

  // 3-5) std_<tool>_<pid> → tool_runs (개별 도구 실행 결과)
  function syncToolRun(client, key, raw) {
    var m = /^std_([^_]+)_(.+)$/.exec(key);
    if (!m) return Promise.resolve();
    var toolId = m[1], pidPart = m[2];
    var data = jparse(raw, raw);
    var syncId = (pidPart && pidPart !== 'standalone') ? pidPart : null;
    return resolveProject(client, syncId, 'TOOL ' + toolId, null).then(function (projId) {
      var row = {
        company_id: companyId, project_id: projId,
        tool_id: 'Tool-' + toolId, tool_category: 'standalone',
        title: 'Tool ' + toolId + (syncId ? (' · ' + syncId) : ''),
        inputs: { storage_key: key, project_sync_id: syncId },
        results: (data && typeof data === 'object') ? data : { raw: String(raw) }
      };
      // 같은 도구+프로젝트는 1행 유지(replace)
      var q = client.from('tool_runs').delete()
        .eq('company_id', companyId).eq('tool_id', row.tool_id).eq('tool_category', 'standalone');
      q = projId ? q.eq('project_id', projId) : q.is('project_id', null);
      return q.then(function () { return client.from('tool_runs').insert(row); });
    });
  }

  // 3-6) HIMEC_SAVE_DATA → diagnoses + equipment_units + equipment_diag_items
  var D1_TYPES = ['coldSource','heatSource','heatex','coolingTower','ahu','fan',
                  'fcu','pump','header','tank','snpump','plumbing','pipe'];
  function syncDiagnosis(client, raw) {
    var o = jparse(raw, null); if (!o) return Promise.resolve();
    var syncId = (typeof w.himecActiveProjectSyncId === 'function' && w.himecActiveProjectSyncId())
              || (o.projectOverview && o.projectOverview.projectName) || 'HIMEC';
    var pname = (o.projectOverview && o.projectOverview.projectName) || syncId;
    return resolveProject(client, syncId, pname, null).then(function (projId) {
      if (!projId) return null;
      // diagnoses (phase 1) upsert by (project_id, phase)
      return client.from('diagnoses').upsert({
          project_id: projId, phase: 1, version: o._version || 1,
          overview: o.projectOverview || {}, saved_at: o._savedAt || nowIso()
        }, { onConflict: 'project_id,phase' })
        .select('id').single()
        .then(function (dr) {
          var diagId = dr && dr.data ? dr.data.id : null;
          if (!diagId) return null;
          // 기존 units 제거 후 재구성(replace)
          return client.from('equipment_units').delete().eq('diagnosis_id', diagId)
            .then(function () { return buildUnits(client, diagId, o); });
        });
    });
  }

  function buildUnits(client, diagId, o) {
    var d1 = (o.diagnosis1st && o.diagnosis1st._cardData) || {};
    var d2raw = o.diagnosis2nd || {};
    var unitRows = [], diagItemPlan = [];
    D1_TYPES.forEach(function (type) {
      var byId = d1[type]; if (!byId) return;
      Object.keys(byId).forEach(function (idStr) {
        var card = byId[idStr] || {};
        var measurements = {}, diagItems = card._diag || {};
        Object.keys(card).forEach(function (k) {
          if (k.charAt(0) === 'f') measurements[k] = card[k];
        });
        var uIndex = parseInt(idStr, 10) || 1;
        unitRows.push({
          diagnosis_id: diagId, equip_type: type,
          equip_subtype: (o.diagnosis1st._unitSubtype &&
                          o.diagnosis1st._unitSubtype[type] &&
                          o.diagnosis1st._unitSubtype[type][idStr]) || null,
          unit_index: uIndex,
          nameplate: card._nameplate || {},
          measurements: measurements,
          opinion: card._opinion || null,
          photos: (o.diagnosis1st._unitPhotos &&
                   o.diagnosis1st._unitPhotos[type] &&
                   o.diagnosis1st._unitPhotos[type][idStr]) || [],
          d2_data: d2raw[type] && d2raw[type][idStr] ? d2raw[type][idStr] : null,
          _items: Object.keys(diagItems).map(function (key) {
            var it = diagItems[key] || {};
            return { item_key: key, rate: it.rate || null, content: it.content || null, note: it.note || null };
          })
        });
      });
    });
    if (!unitRows.length) return null;
    var plans = unitRows.map(function (u) { return u._items; });
    unitRows.forEach(function (u) { delete u._items; });
    return chunkInsertReturning(client, 'equipment_units', unitRows).then(function (inserted) {
      if (!inserted) return null;
      var itemRows = [];
      inserted.forEach(function (row, i) {
        (plans[i] || []).forEach(function (it) {
          if (!it.item_key) return;
          itemRows.push({
            unit_id: row.id, item_key: it.item_key,
            rate: it.rate, content: it.content, note: it.note
          });
        });
      });
      return itemRows.length ? chunkInsert(client, 'equipment_diag_items', itemRows) : null;
    });
  }

  /* ---------------------------------------------------------------
   * 4. 청크 INSERT (대용량/요청 크기 고려)
   * --------------------------------------------------------------- */
  function chunkInsert(client, table, rows, size) {
    size = size || 200;
    var chain = Promise.resolve();
    for (var i = 0; i < rows.length; i += size) {
      (function (slice) {
        chain = chain.then(function () { return client.from(table).insert(slice); });
      })(rows.slice(i, i + size));
    }
    return chain;
  }
  function chunkInsertReturning(client, table, rows, size) {
    size = size || 200;
    var out = [];
    var chain = Promise.resolve();
    for (var i = 0; i < rows.length; i += size) {
      (function (slice) {
        chain = chain.then(function () {
          return client.from(table).insert(slice).select('*').then(function (r) {
            if (r && r.data) out = out.concat(r.data);
          });
        });
      })(rows.slice(i, i + size));
    }
    return chain.then(function () { return out; });
  }

  /* ---------------------------------------------------------------
   * 5. 디스패처 + 디바운스
   * --------------------------------------------------------------- */
  var DISPATCH = {
    'himec_metrics': syncMetrics,
    'gh_file_data/projects.json': syncProjects,
    'himec_pm_tool_v23': syncPm,
    'himec_tool_projects': syncToolRegistry,
    'HIMEC_SAVE_DATA': syncDiagnosis
  };
  function routeKey(key) {
    if (DISPATCH[key]) return DISPATCH[key];
    if (/^std_[^_]+_/.test(key)) return function (c, raw) { return syncToolRun(c, key, raw); };
    return null;
  }

  var _timers = {};
  function scheduleMirror(key, value) {
    if (key === 'activeProjectId') return; // 세션값 제외
    var fn = routeKey(key);
    if (!fn) return;
    clearTimeout(_timers[key]);
    _timers[key] = setTimeout(function () {
      withClient(function (client) {
        log('mirror →', key);
        return fn(client, value);
      });
    }, CFG.WRITE_DEBOUNCE_MS || 1500);
  }

  /* ---------------------------------------------------------------
   * 6. localStorage 후킹 (Local 은 항상 먼저 저장 → 그 후 Cloud 미러)
   * --------------------------------------------------------------- */
  try {
    _ls.setItem = function (key, value) {
      _origSet(key, value);             // 1) 로컬 우선 저장(기존 동작 보존)
      try { scheduleMirror(key, value); } catch (e) { warn('mirror sched fail', e); }
    };
    _ls.removeItem = function (key) {
      _origRemove(key);
      // 삭제 미러는 데이터 유실 위험이 있어 기본 비활성(필요 시 확장)
    };
  } catch (e) { warn('hook install fail', e); }

  /* ---------------------------------------------------------------
   * 7. 최초 1회 클라우드 → 로컬 복원 (로컬이 빈 경우)
   *    가장 최근 백업 스냅샷을 그대로 복원하여 6키 동기화.
   * --------------------------------------------------------------- */
  function hydrateIfEmpty() {
    if (!CFG.HYDRATE_ON_EMPTY) return;
    var anyLocal = ['HIMEC_SAVE_DATA','himec_pm_tool_v23','gh_file_data/projects.json',
                    'himec_tool_projects','himec_metrics']
                   .some(function (k) { return !!_origGet(k); });
    if (anyLocal) return;
    withClient(function (client) {
      var base = companyId + '/' + (CFG.BACKUP_PREFIX || '_backups') + '/';
      return client.storage.from(CFG.BACKUP_BUCKET || 'project-docs').list(
        companyId + '/' + (CFG.BACKUP_PREFIX || '_backups'),
        { limit: 100, sortBy: { column: 'name', order: 'desc' } }
      ).then(function (r) {
        if (!r || !r.data || !r.data.length) return;
        var latest = r.data.filter(function (f) { return /\.json$/.test(f.name); })[0];
        if (!latest) return;
        return client.storage.from(CFG.BACKUP_BUCKET || 'project-docs')
          .download(base + latest.name)
          .then(function (dl) { return dl && dl.data ? dl.data.text() : null; })
          .then(function (txt) {
            if (!txt) return;
            var snap = jparse(txt, null);
            if (!snap || !snap.keys) return;
            Object.keys(snap.keys).forEach(function (k) {
              if (snap.keys[k] != null) _origSet(k, snap.keys[k]); // 후킹 우회(루프 방지)
            });
            log('hydrated from', latest.name);
          });
      });
    });
  }

  /* ---------------------------------------------------------------
   * 8. 10분 간격 백업 (파일 크기 고려)
   *    - 6키 스냅샷 → Storage(project-docs)/{company}/_backups/<ts>.json
   *    - 직전과 동일하면 skip (해시 비교)
   *    - BACKUP_MAX_INLINE_BYTES 초과 시 base64 사진을 분리(마커 치환)
   *    - storage_files 메타 1행 기록, 오래된 백업 정리
   * --------------------------------------------------------------- */
  var BK_KEYS = ['HIMEC_SAVE_DATA','himec_pm_tool_v23','gh_file_data/projects.json',
                 'himec_tool_projects','himec_metrics',
                 'HIMEC_SUMMARY_STATE','HIMEC_SUBJECT_NOTES','HIMEC_SUBJECT_ETC'];
  var _lastHash = null;

  function hashStr(s) { // 경량 해시(djb2)
    var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }
  function stripBigBase64(snapStr) {
    // data:[mime];base64,.... 형태의 큰 값 치환 (백업 용량 절감)
    return snapStr.replace(/"data:[^"]{2000,}"/g, '"[omitted-base64]"');
  }

  function doBackup() {
    if (!ENABLED) return;
    var keys = {};
    BK_KEYS.forEach(function (k) { var v = _origGet(k); if (v != null) keys[k] = v; });
    var snap = { _type: 'himec-backup', _at: nowIso(), company_id: companyId, keys: keys };
    var str = JSON.stringify(snap);
    if (str.length > (CFG.BACKUP_MAX_INLINE_BYTES || 3145728)) {
      // 용량 초과 → 사진(base64) 분리 버전으로 축소
      var slim = JSON.parse(JSON.stringify(snap));
      Object.keys(slim.keys).forEach(function (k) {
        slim.keys[k] = stripBigBase64(slim.keys[k]);
      });
      slim._note = 'large-payload: base64 stripped';
      str = JSON.stringify(slim);
    }
    var h = hashStr(str);
    if (h === _lastHash) { log('backup skip (unchanged)'); return; }

    withClient(function (client) {
      var ts = nowIso().replace(/[:.]/g, '-');
      var path = companyId + '/' + (CFG.BACKUP_PREFIX || '_backups') + '/' + ts + '.json';
      var blob = new Blob([str], { type: 'application/json' });
      return client.storage.from(CFG.BACKUP_BUCKET || 'project-docs')
        .upload(path, blob, { upsert: true, contentType: 'application/json' })
        .then(function (up) {
          if (up && up.error) { warn('backup upload err', up.error); return; }
          _lastHash = h;
          log('backup saved', path, (str.length / 1024).toFixed(1) + 'KB');
          // 메타 기록
          client.from('storage_files').insert({
            company_id: companyId, project_id: null, doc_type: 'backup',
            bucket: CFG.BACKUP_BUCKET || 'project-docs', path: path,
            original_name: ts + '.json', size_bytes: str.length
          }).then(function () {}, function () {});
          // 오래된 백업 정리
          return cleanupBackups(client);
        });
    });
  }

  function cleanupBackups(client) {
    var keep = CFG.BACKUP_KEEP || 24;
    var folder = companyId + '/' + (CFG.BACKUP_PREFIX || '_backups');
    return client.storage.from(CFG.BACKUP_BUCKET || 'project-docs')
      .list(folder, { limit: 1000, sortBy: { column: 'name', order: 'desc' } })
      .then(function (r) {
        if (!r || !r.data) return;
        var olds = r.data.filter(function (f) { return /\.json$/.test(f.name); }).slice(keep);
        if (!olds.length) return;
        var paths = olds.map(function (f) { return folder + '/' + f.name; });
        return client.storage.from(CFG.BACKUP_BUCKET || 'project-docs').remove(paths);
      });
  }

  /* ---------------------------------------------------------------
   * 9. 부팅
   * --------------------------------------------------------------- */
  function boot() {
    if (!ENABLED) { log('sync disabled (config placeholder or ENABLE_SYNC=false)'); return; }
    sbReady.then(function (client) {
      if (!client) return;
      hydrateIfEmpty();
      setInterval(doBackup, CFG.BACKUP_INTERVAL_MS || 600000);
      // 페이지 이탈 직전 마지막 백업 시도(best-effort)
      w.addEventListener('beforeunload', function () { try { doBackup(); } catch (e) {} });
    });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* tool_runs(registry) → { toolId: [{id,name,year}, ...] } 재구성
     dashboard.html 등에서 클라우드 목록을 불러올 때 사용. */
  function loadToolRegistry() {
    return withClient(function (client) {
      return client.from('tool_runs')
        .select('tool_id,results')
        .eq('company_id', companyId)
        .eq('tool_category', 'registry')
        .then(function (r) {
          if (!r || !r.data || !r.data.length) return null; // 없으면 null → 호출측에서 localStorage 폴백
          var reg = {};
          r.data.forEach(function (row) {
            var t = row.tool_id; if (!t) return;
            (reg[t] = reg[t] || []).push(row.results || {});
          });
          return reg;
        });
    });
  }

  /* 외부에서 수동 트리거용 핸들 노출 */
  w.HIMEC_SYNC = {
    backupNow: doBackup,
    mirrorKey: function (k) { scheduleMirror(k, _origGet(k)); },
    isEnabled: function () { return ENABLED; },
    ready: function () { return sbReady; },
    loadToolRegistry: loadToolRegistry
  };
})(window, document);
