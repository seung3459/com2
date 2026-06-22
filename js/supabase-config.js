/* =====================================================================
 * HIMEC · Supabase 연결 설정
 * ---------------------------------------------------------------------
 * 배포 시 아래 SUPABASE_URL / SUPABASE_ANON_KEY 만 본인 프로젝트 값으로
 * 교체하면 됩니다. (Vercel 환경변수로 빼고 싶다면 빌드 단계에서 주입)
 *
 * ※ 이 파일은 "저장소 설정"만 담당합니다. UI/비즈니스 로직 무관.
 * ===================================================================== */
(function (w) {
  'use strict';

  w.HIMEC_SUPABASE_CONFIG = {
    /* 1) 필수: Supabase 프로젝트 정보 ---------------------------------- */
    SUPABASE_URL: 'https://njlvcuqclmzfpcergfgj.supabase.co/rest/v1/',
    SUPABASE_ANON_KEY: 'sb_publishable_n_1_pqQy-CfLtC_QiCi73Q_OC7D3z81',

    /* 2) 멀티테넌시(회사) 식별 ----------------------------------------
     * RLS current_company_id() 기준 격리 컬럼에 들어갈 값.
     * 로그인 연동 전(테스트)에는 고정 UUID를 사용합니다.
     * 우선순위: localStorage('HIMEC_COMPANY_ID') > 아래 기본값            */
    DEFAULT_COMPANY_ID: '00000000-0000-0000-0000-000000000001',

    /* 3) 동작 옵션 ----------------------------------------------------- */
    ENABLE_SYNC: true,        // false 면 순수 Local 로만 동작
    HYDRATE_ON_EMPTY: true,   // 로컬이 비었을 때 클라우드에서 1회 복원
    WRITE_DEBOUNCE_MS: 1500,  // 연속 저장 묶기(키 입력 폭주 방지)
    DEBUG: false,             // true 면 콘솔에 sync 로그 출력

    /* 4) 백업 옵션 ----------------------------------------------------- */
    BACKUP_INTERVAL_MS: 10 * 60 * 1000,   // 10분
    BACKUP_BUCKET: 'project-docs',        // Storage 버킷
    BACKUP_PREFIX: '_backups',            // {company}/_backups/<ts>.json
    BACKUP_MAX_INLINE_BYTES: 3 * 1024 * 1024, // 3MB 초과 시 사진(base64) 분리/생략
    BACKUP_KEEP: 24                       // 최근 24개(=4시간) 유지, 초과분 정리
  };

  /* current_company_id() 프런트 측 헬퍼 */
  w.himecCompanyId = function () {
    try {
      var v = localStorage.getItem('HIMEC_COMPANY_ID');
      if (v) return v;
    } catch (e) {}
    return w.HIMEC_SUPABASE_CONFIG.DEFAULT_COMPANY_ID;
  };

  /* 현재 활성 프로젝트(세션값) — projects.sync_id 매칭에 사용 */
  w.himecActiveProjectSyncId = function () {
    try { return localStorage.getItem('activeProjectId') || null; }
    catch (e) { return null; }
  };
})(window);