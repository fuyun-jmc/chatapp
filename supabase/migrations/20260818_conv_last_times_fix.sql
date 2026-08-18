-- ============================================================
-- 硬化 get_my_conv_last_times() 的列名
-- ------------------------------------------------------------
-- 原实现第一段用 select peer, ... 作为 UNION 首段，列名在不同
-- 客户端/PostgREST 版本下可能被解析为 peer 或 peer_id，导致前端
-- 合并会话浮顶时间时 DM 行取不到 peer_id（仅 group 行有效），
-- 叠加 WebView localStorage 不可靠，就出现「发送后置顶、刷新回原位」。
-- 这里把两段都显式别名 peer_id，消除歧义，DM / 群聊行都稳定返回 peer_id。
-- 与 20260816_conv_last_times.sql 同源，create or replace 覆盖即可。
-- ============================================================

create or replace function public.get_my_conv_last_times()
returns table (peer_id uuid, last_ts timestamptz)
language sql
security definer
set search_path = public
as $$
  -- 单聊：与当前用户相关的、非群消息，peer = 对方用户 id
  select peer_id, max(created_at) as last_ts
  from (
    select m.sender_id as peer_id, m.created_at
    from public.messages m
    where m.group_id is null
      and m.receiver_id = auth.uid()
      and m.recalled = false
      and m.hidden_forbidden = false
      and not (coalesce(m.deleted_by, '{}') && array[auth.uid()])
    union all
    select m.receiver_id as peer_id, m.created_at
    from public.messages m
    where m.group_id is null
      and m.sender_id = auth.uid()
      and m.recalled = false
      and m.hidden_forbidden = false
      and not (coalesce(m.deleted_by, '{}') && array[auth.uid()])
  ) t
  group by peer_id

  union all

  -- 群聊：当前用户所属群的最后消息时间
  select m.group_id as peer_id, max(m.created_at) as last_ts
  from public.messages m
  join public.group_members gm on gm.group_id = m.group_id and gm.user_id = auth.uid()
  where m.group_id is not null
    and m.recalled = false
    and m.hidden_forbidden = false
    and not (coalesce(m.deleted_by, '{}') && array[auth.uid()])
  group by m.group_id
$$;

grant execute on function public.get_my_conv_last_times() to authenticated;

notify pgrst, 'reload schema';
