/* =========================================================
   HIMEC 로그인 가드 + 로그아웃 (auth-guard.js)
   - URL·키는 /js/supabase-config.js 의 값을 그대로 사용 (별도 입력 불필요)
   - [가드] 로그인 안 한 사용자를 login.html 로 보냄 (깜빡임 방지)
   - [로그아웃] 어느 페이지에서든 himecLogout() 호출하면 로그아웃됨
       예) <button onclick="himecLogout()">로그아웃</button>

   ※ 로드 순서 (각 페이지 <head>):
       1) supabase-config.js   (이 파일보다 먼저!)
       2) auth-guard.js        (이 파일)
       3) himec-supabase-sync.js
   ========================================================= */
(function () {
  "use strict";

  // 공용 설정에서 URL·키 가져오기 (supabase-config.js 가 먼저 로드돼 있어야 함)
  var CFG = window.HIMEC_SUPABASE_CONFIG || {};
  var SUPABASE_URL = CFG.SUPABASE_URL;
  var SUPABASE_ANON_KEY = CFG.SUPABASE_ANON_KEY;

  // 설정을 못 찾으면(로드 순서 문제) 사이트가 멈추지 않도록 경고만 남기고 통과
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    if (window.console) {
      console.error("[auth-guard] HIMEC_SUPABASE_CONFIG 를 찾지 못했습니다. " +
        "supabase-config.js 가 auth-guard.js 보다 먼저 로드되는지 확인하세요.");
    }
    document.documentElement.style.visibility = "visible";
    return;
  }

  // Supabase 클라이언트 (한 번만 생성해서 재사용)
  var _client = null;
  function getClient() {
    if (!_client) _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return _client;
  }

  // Supabase 라이브러리가 준비되면 콜백 실행 (없으면 불러온 뒤 실행)
  function ready(cb) {
    if (window.supabase && window.supabase.createClient) { cb(); return; }
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    s.onload = cb;
    s.onerror = function () { window.location.replace("/login.html"); };
    document.head.appendChild(s);
  }

  /* ===== 로그아웃 함수 (전역) =====
     어느 페이지에서든 himecLogout() 호출 → 로그아웃 후 로그인 화면으로 */
  window.himecLogout = function () {
    ready(function () {
      getClient().auth.signOut().then(function () {
        window.location.replace("/login.html");
      }).catch(function () {
        window.location.replace("/login.html");
      });
    });
  };

  /* ===== 로그인 가드 ===== */
  // 로그인 페이지 자신은 가드 제외 (무한 이동 방지)
  if (location.pathname.indexOf("login.html") !== -1) return;

  // 인증 확인 전까지 화면 숨김 (깜빡임 방지)
  var root = document.documentElement;
  root.style.visibility = "hidden";
  function reveal() { root.style.visibility = "visible"; }
  function goLogin() { window.location.replace("/login.html"); }

  // 혹시 4초 안에 확인이 안 되면 그냥 화면을 보여줌 (영구 흰 화면 방지)
  var safety = setTimeout(reveal, 4000);

  ready(function () {
    getClient().auth.getSession().then(function (res) {
      clearTimeout(safety);
      if (res.data.session) {
        reveal();    // 로그인 됨 → 화면 표시
      } else {
        goLogin();   // 로그인 안 됨 → 로그인 페이지로
      }
    }).catch(function () {
      clearTimeout(safety);
      goLogin();
    });
  });
})();
