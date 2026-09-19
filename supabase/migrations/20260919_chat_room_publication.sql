-- ============================================================================
--  v301：在线聊天室 · 第 2 步（单独执行，勿与其他 SQL 同批粘贴）
--   把 chatroom_messages 加入 supabase_realtime 发布，前端才能实时收到新消息。
--   ⚠ 为什么要单独跑：replica identity / alter publication 需要排他锁，
--     与建表等长事务一起执行会与 Realtime 后台连接互相等待 → 40P01 死锁。
--   ⚠ 执行前关闭其它正在运行的 SQL Editor 标签页。
--   lock_timeout 让拿不到锁时 5 秒内快速失败（重跑即可），而不是挂死成死锁。
--  幂等可重跑。
-- ============================================================================
set lock_timeout = '5s';

alter table public.chatroom_messages replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.chatroom_messages;
  exception when duplicate_object then null;
  end;
end $$;

reset lock_timeout;

notify pgrst, 'reload schema';
