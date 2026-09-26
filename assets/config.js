/* ============================================================
 *  配置文件 —— 部署前只需要改这里
 *
 *  在 Supabase 控制台 → Project Settings → API 页面可以找到：
 *    Project URL  ->  SUPABASE_URL
 *    anon public  ->  SUPABASE_ANON_KEY
 *
 *  anon key 是设计上就可以公开在前端的密钥，数据安全由数据库的
 *  RLS 行级安全策略保证（schema.sql 里已经配好）。
 *  绝对不要把 service_role key 写在这里。
 * ============================================================ */

window.CHAT_CONFIG = {
  // ===== 临时切换：本机自建后端（PostgREST + gateway.py）经 cloudflared 隧道暴露 =====
  // 注意：这是 quick tunnel，每次重启 cloudflared 域名都会变，需要同步改这里
  // （start_all.py 启动后会打印新地址）。切回 Supabase 时把下面两行换回原值即可。
  SUPABASE_URL: 'https://essays-ratio-dispatched-pad.trycloudflare.com',
  // 用本地 JWT secret 签发的长期 anon JWT（role=anon），等价于 Supabase 的 anon public key
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc5MDM4NDQ2MSwiZXhwIjoyMTA1NzQ0NDYxLCJyb2xlIjoiYW5vbiJ9.Nw1rVl3lLVmtKzTYOR0fMUydfcq11kX91DzMPoha1rY',
  // ---------- 原 Supabase 配置（保留备用）----------
  // SUPABASE_URL: 'https://qbijifskzkhianacsjqp.supabase.co',
  // SUPABASE_ANON_KEY: 'sb_publishable_GiAzZDEekVhA0QAqy8djgg_mvHI79ws',

  // 存储桶名称，与 schema.sql 中创建的保持一致
  BUCKET: 'chat-files',

  // 手机号在 Supabase Auth 内部映射成的邮箱域名。
  // 用户看不到它，只是为了复用免费的邮箱密码登录、避开付费短信。
  // 若注册时提示 "Email address is invalid"，把它换成 example.com 再试。
  EMAIL_DOMAIN: 'chatapp.local',

  // 单个文件大小上限（MB）。Supabase 免费版客户端单文件上传默认上限约 50MB，
  // 视频放宽到 1GB 实测会失败，故维持保守的 50MB。
  MAX_IMAGE_MB: 10,
  MAX_VIDEO_MB: 50,
  MAX_FILE_MB: 20,

  // 每次进入会话加载的历史消息条数
  HISTORY_LIMIT: 300
};
