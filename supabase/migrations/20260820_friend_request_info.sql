-- ============================================================
--  好友申请信息（文字说明 + 多张图片）
--  用法：Supabase 控制台 → SQL Editor → 全文粘贴 → Run
--  可重复执行（幂等）
-- ============================================================
--
-- 设计要点：
--   1) request_note  text  —— 申请方填写的留言（可留空直接发）。
--   2) request_images jsonb —— 申请方上传的图片存储路径数组（可空 / 空数组）。
--      路径格式与聊天文件一致：<requester_uid>/<random>.<ext>，命中既有
--      upload + avatar_read 策略，无需新增 storage policy。
--   3) 重新发起（之前被拒绝过）会把新的留言 / 图片覆盖写回该行。

-- 1) 列（已部署过的旧库不会因建表语句自动加列，这里用 ALTER 补齐）
alter table public.friendships
  add column if not exists request_note   text,
  add column if not exists request_images jsonb;   -- 路径数组，空为 null

-- 2) 兼容旧数据：若字段已存在但为 null，保持 null（前端按空处理）。无需回填。

notify pgrst, 'reload schema';

select '好友申请信息（request_note / request_images）已就绪：申请方可填写留言并附多张图片' as status;
