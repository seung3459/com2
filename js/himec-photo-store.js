/* =====================================================================
 * HIMEC · 사진 저장 헬퍼  (himec-photo-store.js)
 * ---------------------------------------------------------------------
 * 목적 : 진단 사진을 base64로 blob에 박지 않고, Supabase Storage(private
 *        버킷 'project-docs')에 업로드한 뒤 "경로(path)"만 데이터에 남긴다.
 *        조회는 path 로 서명 URL(signed URL)을 발급해 <img src>에 꽂는다.
 *
 * 사용 : 로그인된 Supabase 클라이언트(himec-supabase-sync.js 의
 *        HIMEC_SYNC.ready())를 그대로 재사용하므로, 이 파일은
 *        himec-supabase-sync.js "뒤"에 1줄 추가하면 된다.
 *           <script src="/js/himec-photo-store.js"></script>
 *
 * 노출 : window.HIMEC_PHOTO
 *   - upload(dataURLorBlob, name) -> Promise<path|null>   업로드(실패 시 null)
 *   - signOne(path)               -> Promise<url|null>    단건 서명 URL
 *   - signMany([path,...])        -> Promise<{path:url}>  다건 서명 URL(일괄)
 *   - dataURLtoBlob(dataURL)      -> Blob
 *
 * ※ private 버킷 정책(인증 사용자 전체 허용)이 깔려 있어야 동작.
 *   업로드/조회가 거부되면(오프라인 등) 호출부가 base64 폴백으로 처리.
 * ===================================================================== */
(function (w, d) {
  'use strict';
  if (w.HIMEC_PHOTO) return;

  var CFG     = w.HIMEC_SUPABASE_CONFIG || {};
  var BUCKET  = CFG.BACKUP_BUCKET || 'project-docs';
  var SIGN_TTL = 60 * 60 * 4; // 서명 URL 유효시간 4시간(작업 세션 길이 고려)

  function log()  { if (CFG.DEBUG && w.console) console.log.apply(console, ['[photo]'].concat([].slice.call(arguments))); }
  function warn() { if (w.console) console.warn.apply(console, ['[photo]'].concat([].slice.call(arguments))); }

  /* 로그인 세션이 붙은 Supabase 클라이언트 재사용(오프라인/비활성이면 null) */
  function client() {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(null);
      if (w.HIMEC_SYNC && typeof w.HIMEC_SYNC.ready === 'function') return w.HIMEC_SYNC.ready();
    } catch (e) {}
    return Promise.resolve(null);
  }

  function companyId() {
    try { return (typeof w.himecCompanyId === 'function') ? w.himecCompanyId() : 'default'; }
    catch (e) { return 'default'; }
  }
  function projectId() {
    try { return localStorage.getItem('activeProjectId') || 'default'; }
    catch (e) { return 'default'; }
  }

  /* dataURL(base64) -> Blob */
  function dataURLtoBlob(dataURL) {
    var parts = String(dataURL).split(',');
    var meta = parts[0] || '';
    var b64  = parts[1] || '';
    var mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    var bin = atob(b64);
    var n = bin.length;
    var u8 = new Uint8Array(n);
    while (n--) u8[n] = bin.charCodeAt(n);
    return new Blob([u8], { type: mime });
  }

  /* 업로드: dataURL 또는 Blob → 성공 시 저장경로(path), 실패 시 null */
  function upload(src, name) {
    return client().then(function (c) {
      if (!c) return null;
      var blob = (typeof src === 'string') ? dataURLtoBlob(src) : src;
      var safe = String(name || 'photo').replace(/[^\w.-]/g, '_');
      var path = companyId() + '/' + projectId() + '/' + safe + '_' + Date.now() + '.jpg';
      return c.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true })
        .then(function (r) {
          if (r && r.error) { warn('upload err', r.error.message || r.error); return null; }
          log('uploaded', path);
          return path;
        }).catch(function (e) { warn('upload throw', e); return null; });
    });
  }

  /* 단건 서명 URL */
  function signOne(path) {
    return client().then(function (c) {
      if (!c || !path) return null;
      return c.storage.from(BUCKET).createSignedUrl(path, SIGN_TTL).then(function (r) {
        if (r && r.error) { warn('sign err', path, r.error.message || r.error); return null; }
        return (r && r.data && r.data.signedUrl) || null;
      }).catch(function () { return null; });
    });
  }

  /* 다건 서명 URL → { path: url } 맵 */
  function signMany(paths) {
    return client().then(function (c) {
      if (!c || !paths || !paths.length) return {};
      var uniq = paths.filter(function (p, i) { return p && paths.indexOf(p) === i; });
      if (!uniq.length) return {};
      return c.storage.from(BUCKET).createSignedUrls(uniq, SIGN_TTL).then(function (r) {
        var map = {};
        if (r && r.data) {
          r.data.forEach(function (o) { if (o && o.path && o.signedUrl) map[o.path] = o.signedUrl; });
        }
        return map;
      }).catch(function () { return {}; });
    });
  }

  w.HIMEC_PHOTO = {
    upload: upload,
    signOne: signOne,
    signMany: signMany,
    dataURLtoBlob: dataURLtoBlob,
    companyId: companyId,
    projectId: projectId,
    bucket: BUCKET
  };
})(window, document);
