/* =====================================================================
 * HIMEC · 분석툴 결과 리포터  (himec-tool-result.js)
 * ---------------------------------------------------------------------
 * 목적 : 각 분석툴의 결과를 "프로젝트별"로 한 곳(localStorage: himec_tool_results)에
 *        모아, Metrics가 가로질러 읽을 수 있게 한다.
 *
 * 사용법(툴 파일당 단 1줄, <head>에 추가):
 *     <script src="/js/himec-tool-result.js"></script>
 *   (계산 로직/UI/기존 저장은 전혀 건드리지 않음. "추가로" 요약만 기록)
 *
 * 동작 :
 *   - 대시보드에서 ?projectId=...&projectName=... 으로 열렸을 때만 기록
 *   - 입력/계산이 끝난 화면의 모든 필드값(스냅샷)을 그대로 저장
 *     (어느 칸이 결과값인지는 Metrics의 중앙 TOOL_MAP 에서 해석 — 여긴 해석 안 함)
 *
 * 저장 구조 :
 *   himec_tool_results = {
 *     [projectId]: {
 *       [toolKey]: { projectName, tool, fields:{ id:value, ... }, savedAt }
 *     }
 *   }
 *   · toolKey = 파일명(확장자 제외), 예) 'Tool-303__Fan_Efficiency'
 *
 * ※ 클라우드 동기화 : himec-supabase-sync.js 의 추적 키 목록에
 *   'himec_tool_results' 를 한 줄 추가해야 app_state 로 미러링됨(아래 안내).
 * ===================================================================== */
(function (w, d) {
  'use strict';
  if (w.__HIMEC_TR_INSTALLED) return;
  w.__HIMEC_TR_INSTALLED = true;

  var REGISTRY_KEY = 'himec_tool_results';

  function qp(k) { try { return new URLSearchParams(location.search).get(k) || ''; } catch (e) { return ''; } }
  var projectId   = qp('projectId') || qp('project') || qp('id') || '';
  var projectName = qp('projectName') || '';

  function toolKey() {
    var p = (location.pathname || '').split('/').pop() || '';
    p = decodeURIComponent(p).replace(/\.html?$/i, '');
    return p || (d.title || 'tool');
  }

  function readEl(el) {
    if (el == null) return '';
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '';
      return el.value;
    }
    return (el.textContent || '').trim();
  }

  // 화면 스냅샷: 폼 입력값 + 계산 표시값(val-/calc-/out-/result-/grade-)
  function snapshot() {
    var fields = {};
    try {
      Array.prototype.forEach.call(d.querySelectorAll('input[id],select[id],textarea[id]'), function (el) {
        fields[el.id] = readEl(el);
      });
      Array.prototype.forEach.call(d.querySelectorAll('[id]'), function (el) {
        if (el.id in fields) return;
        var cls = (typeof el.className === 'string') ? el.className : '';
        var isResult = /metric-value|metric-val|result-value/.test(cls)
                    || /^(val|calc|out|result|grade|verdict|judge|status|metric|m[-_])/.test(el.id);
        if (isResult) { var t = readEl(el); if (t !== '') fields[el.id] = t; }
      });
    } catch (e) {}
    return fields;
  }

  function capture() {
    if (!projectId) return;            // 프로젝트로 열린 경우만 기록
    try {
      var reg = {};
      try { reg = JSON.parse(localStorage.getItem(REGISTRY_KEY) || '{}') || {}; } catch (e) { reg = {}; }
      if (!reg[projectId]) reg[projectId] = {};
      var tk = toolKey();
      reg[projectId][tk] = {
        projectName: projectName,
        tool: tk,
        fields: snapshot(),
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
    } catch (e) { if (w.console) console.warn('[himec-tool-result] capture fail', e); }
  }

  var _t;
  function schedule() { clearTimeout(_t); _t = setTimeout(capture, 1200); }

  function boot() {
    if (!projectId) return;
    d.addEventListener('input', schedule, true);
    d.addEventListener('change', schedule, true);
    w.addEventListener('beforeunload', capture);
    setTimeout(capture, 2000);        // 복원/초기 계산 후 1회
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 외부 핸들 (필요 시 수동 기록)
  w.HIMEC_TOOL_RESULT = { captureNow: capture, registryKey: REGISTRY_KEY };
})(window, document);
