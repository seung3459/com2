/* =========================================================
   HIMEC 로그인 가드 + 로그아웃 (auth-guard.js)
   [구조] index.html = 로그인 화면 / main.html = 메인 / 하위 = 기능 페이지

   - URL·키는 /js/supabase-config.js 의 값을 사용
   - 로그인 안 된 사용자는 index.html(로그인)로 보냄
   - index.html(로그인 화면)에서는 가드가 동작하지 않음 (핑퐁 방지)
   - 로그아웃: 어느 페이지에서든 himecLogout() 호출

   ※ 넣는 위치: 보호할 페이지(main.html, 하위 페이지)의 <head>
       1) supabase-config.js
       2) auth-guard.js   ← 이 파일
       3) himec-supabase-sync.js
     (index.html = 로그인 화면에는 넣지 마세요)
   ========================================================= */
(function () {
  "use strict";

  var CFG = window.HIMEC_SUPABASE_CONFIG || {};
  var SUPABASE_URL = CFG.SUPABASE_URL;
  var SUPABASE_ANON_KEY = CFG.SUPABASE_ANON_KEY;

  // 로그인 페이지(= 루트 / 또는 /index.html) 판별
  var path = (location.pathname || "").toLowerCase();
  var isLoginPage =
    path === "/" || path === "/index.html" || path === "/index" ||
    path.endsWith("/index.html");

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

  // 로그아웃 (전역) → 로그인 화면(index.html)으로
  window.himecLogout = function () {
    ready(function () {
      getClient().auth.signOut().then(function () {
        window.location.replace("/index.html");
      }).catch(function () {
        window.location.replace("/index.html");
      });
    });
  };

  // 로그인 화면에서는 가드 끄기 (무한 이동 방지)
  if (isLoginPage) return;

  // 인증 확인 전까지 화면 숨김
  var root = document.documentElement;
  root.style.visibility = "hidden";
  function reveal() { root.style.visibility = "visible"; }
  function goLogin() { window.location.replace("/index.html"); }

  var safety = setTimeout(reveal, 6000);

  // 인증 OK 후, 복원(hydrate)까지 기다렸다 화면 표시 → 모바일에서 빈 화면이
  // 먼저 뜨는 것을 막는다. 복원이 지연되면 5초 뒤 그냥 표시(무한대기 방지).
  function revealWhenReady() {
    try {
      if (window.HIMEC_SYNC && typeof window.HIMEC_SYNC.whenHydrated === "function") {
        var t = setTimeout(reveal, 5000);
        window.HIMEC_SYNC.whenHydrated().then(function () { clearTimeout(t); reveal(); });
        return;
      }
    } catch (e) {}
    reveal();
  }

  ready(function () {
    getClient().auth.getSession().then(function (res) {
      clearTimeout(safety);
      if (res.data.session) {
        revealWhenReady();
      } else {
        goLogin();
      }
    }).catch(function () {
      clearTimeout(safety);
      goLogin();
    });
  });
})();
