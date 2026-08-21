-- ============================================================
--  消息引用功能：messages 表新增 quote 字段
-- ============================================================
--  quote 为 jsonb 快照，保存被引用消息的关键信息：
--  {
--    "msg_id":     bigint,        -- 被引用消息 id（用于点击定位）
--    "kind":       text,          -- text / image / video / file
--    "content":    text,          -- 文字内容（非文字消息可为空）
--    "file_path":  text,          -- 图片/视频/文件存储路径（用于缩略图预览）
--    "file_name":  text,          -- 文件名（文件类）
--    "sender_id":  uuid,
--    "sender_name":text           -- 发送者昵称快照（对方撤回/删除后仍可显示）
--  }
--  采用快照而非外键：原消息被撤回/本端删除后，引用块仍能完整显示。
--  注意：本文件需在 Supabase SQL Editor 执行；前端发送时写入该列。

alter table public.messages
  add column if not exists quote jsonb;

select 'messages.quote 字段已就绪' as result;
