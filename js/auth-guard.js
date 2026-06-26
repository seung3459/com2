/* =========================================================
   HIMEC 로그인 가드 + 로그아웃 (auth-guard.js)
   - URL·키는 /js/supabase-config.js 의 값을 그대로 사용
   - 로그인 페이지(login.html 또는 /login)에서는 가드 동작 안 함
   - 로그아웃: 어느 페이지에서든 himecLogout() 호출

   ※ 로드 순서 (각 페이지 <head>):
       1) supabase-config.js
       2) auth-guard.js
       3) himec-supabase-sync.js
   ========================================================= */
(function () {
  "use strict";

  var CFG = window.HIMEC_SUPABASE_CONFIG || {};
  var SUPABASE_URL = CFG.SUPABASE_URL;
  var SUPABASE_ANON_KEY = CFG.SUPABASE_ANON_KEY;

  // ▼ 로그인 페이지 경로 (확장자 있든 없든 모두 인식)
  //    사이트가 login.html 을 /login 으로 서빙해도 동작하도록 함
  var path = (location.pathname || "").toLowerCase();
  var isLoginPage =
    path.indexOf("login") !== -1;   // login.html, /login, /login/ 모두 포함

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    if (window.console) {
      console.error("[auth-guard] HIMEC_SUPABASE_CONFIG 를 찾지 못함. " +
        "supabase-config.js 가 auth-guard.js 보다 먼저 로드되는지 확인하세요.");
    }
    document.documentElement.style.visibility = "visible";
    return;
  }

  var _client = null;
  function getClient() {
    if (!_client) _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return _client;
  }

  function ready(cb) {
    if (window.supabase && window.supabase.createClient) { cb(); return; }
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    s.onload = cb;
    s.onerror = function () { document.documentElement.style.visibility = "visible"; };
    document.head.appendChild(s);
  }

  // 로그아웃 (전역)
  window.himecLogout = function () {
    ready(function () {
      getClient().auth.signOut().then(function () {
        window.location.replace("/login.html");
      }).catch(function () {
        window.location.replace("/login.html");
      });
    });
  };

  // ▼ 로그인 페이지에서는 가드 끄기 (핑퐁 방지)
  if (isLoginPage) return;

  // 인증 확인 전까지 화면 숨김
  var root = document.documentElement;
  root.style.visibility = "hidden";
  function reveal() { root.style.visibility = "visible"; }
  function goLogin() { window.location.replace("/login.html"); }

  var safety = setTimeout(reveal, 4000);

  ready(function () {
    getClient().auth.getSession().then(function (res) {
      clearTimeout(safety);
      if (res.data.session) {
        reveal();
      } else {
        goLogin();
      }
    }).catch(function () {
      clearTimeout(safety);
      goLogin();
    });
  });
})();
