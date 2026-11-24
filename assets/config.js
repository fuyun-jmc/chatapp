/* ============================================================
 *  配置文件 —— 部署前只需要改这里
 *
 *  后端：Cloudflare Worker（云端 gateway）+ D1。
 *  Worker 同时实现了 /auth/v1、/rest/v1、/storage/v1，前端 supabase-js 无需改动。
 *
 *  入口有两个，行为一致：
 *    1) https://chat.fuyunchat.top/          （Worker 同源托管站点 + API）
 *    2) https://fuyun-jmc.github.io/chatapp/ （GitHub Pages，接口走 api.fuyunchat.top）
 * ============================================================ */

(function () {
  var API_FALLBACK = 'https://api.fuyunchat.top';
  var host = (window.location.hostname || '').toLowerCase();

  // 站点跑在自己的域名下时用同源（零跨域、无预检开销）；GitHub Pages 用固定 API 域名。
  var apiBase = /(^|\.)fuyunchat\.top$/.test(host) ? window.location.origin : API_FALLBACK;

  window.CHAT_CONFIG = {
    // ===== 后端地址（自动判定，无需手改）=====
    SUPABASE_URL: apiBase,
    // 用 JWT secret 签发的长期 anon JWT（role=anon），等价于 Supabase 的 anon public key
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc5MDM4NDQ2MSwiZXhwIjoyMTA1NzQ0NDYxLCJyb2xlIjoiYW5vbiJ9.Nw1rVl3lLVmtKzTYOR0fMUydfcq11kX91DzMPoha1rY',
    // ---------- 历史配置（保留备用）----------
    // SUPABASE_URL: 'https://chat.fuyunchat.top',
    // SUPABASE_URL: 'https://essays-ratio-dispatched-pad.trycloudflare.com',  // 本地 gateway.py 经 cloudflared 隧道
    // SUPABASE_URL: 'https://qbijifskzkhianacsjqp.supabase.co',
    // SUPABASE_ANON_KEY: 'sb_publishable_GiAzZDEekVhA0QAqy8djgg_mvHI79ws',

    // 存储桶名称，与 schema.sql 中创建的保持一致
    BUCKET: 'chat-files',

    // 手机号在 Auth 内部映射成的邮箱域名。
    // 用户看不到它，只是为了复用邮箱+密码登录、避开付费短信。
    // 若注册时提示 "Email address is invalid"，把它换成 example.com 再试。
    EMAIL_DOMAIN: 'chatapp.local',

    // 单个文件大小上限（MB）
    MAX_IMAGE_MB: 10,
    MAX_VIDEO_MB: 50,
    MAX_FILE_MB: 20,

    // 每次进入会话加载的历史消息条数
    HISTORY_LIMIT: 300
  };
})();
