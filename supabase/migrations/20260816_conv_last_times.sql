-- ============================================================
-- 跨设备会话排序：取每个会话「最后一条可见消息」的时间
-- ------------------------------------------------------------
-- 背景：前端用 state.convTs（内存 + 本浏览器 localStorage）决定
--       左侧会话列表的置顶顺序。同浏览器刷新可恢复，但「换设备 /
--       换浏览器」登录时 convTs 为空，列表会回退到默认顺序。
-- 修复：新增 get_my_conv_last_times()，按 DB 计算每个会话的最后
--       消息时间；前端登录时合并进 convTs（与本地值取较大者），
--       使任意设备登录时列表都能按真实最后活动时间置顶。
-- ============================================================

create or replace function public.get_my_conv_last_times()
returns table (peer_id uuid, last_ts timestamptz)
language sql
security definer
set search_path = public
as $$
  -- 单聊：与当前用户相关的、非群消息，peer = 对方用户 id
  select peer, max(created_at) as last_ts
  from (
    select m.sender_id as peer, m.created_at
    from public.messages m
    where m.group_id is null
      and m.receiver_id = auth.uid()
      and m.recalled = false
      and m.hidden_forbidden = false
      and not (coalesce(m.deleted_by, '{}') && array[auth.uid()])
    union all
    select m.receiver_id as peer, m.created_at
    from public.messages m
    where m.group_id is null
      and m.sender_id = auth.uid()
      and m.recalled = false
      and m.hidden_forbidden = false
      and not (coalesce(m.deleted_by, '{}') && array[auth.uid()])
  ) t
  group by peer

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
