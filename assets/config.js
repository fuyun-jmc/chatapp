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
  SUPABASE_URL: 'https://qbijifskzkhianacsjqp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_GiAzZDEekVhA0QAqy8djgg_mvHI79ws',

  // 存储桶名称，与 schema.sql 中创建的保持一致
  BUCKET: 'chat-files',

  // 手机号在 Supabase Auth 内部映射成的邮箱域名。
  // 用户看不到它，只是为了复用免费的邮箱密码登录、避开付费短信。
  // 若注册时提示 "Email address is invalid"，把它换成 example.com 再试。
  EMAIL_DOMAIN: 'chatapp.local',

  // 单个文件大小上限（MB）。Supabase 免费版单文件上限 50MB，
  // 免费存储总量约 1GB，视频很占空间，建议保守设置。
  MAX_IMAGE_MB: 10,
  MAX_VIDEO_MB: 50,
  MAX_FILE_MB: 20,

  // 每次进入会话加载的历史消息条数
  HISTORY_LIMIT: 300
};
