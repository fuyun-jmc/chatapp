-- ============================================================
--  GM 聊天记录监管：支持查看「已删除好友」的私聊记录
-- ============================================================
-- 背景：删除好友是物理删除 friendships 记录（见前端 gmForceDeleteFriend），
--       因此 gm_list_user_friends 不再返回已删除好友，GM 无法点开其聊天记录。
--       但 messages 表中两人的私聊消息仍保留。本 RPC 从 messages 聚合出
--       该用户所有私聊过的对方，并 left join friendships 标记关系状态，
--       便于前端在昵称后标注「已删除」并提供「聊天」入口。
--  注意：本文件需在 Supabase SQL Editor 执行；前端新区块依赖 gm_list_user_chat_peers。

drop function if exists public.gm_list_user_chat_peers(text, uuid) cascade;

create or replace function public.gm_list_user_chat_peers(p_pwd text, p_user_id uuid)
returns table (
  other_id         uuid,
  other_nickname   text,
  other_phone      text,
  friendship_status text,        -- null 表示已无任何好友关系（即已删除好友）
  last_message_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
  with peers as (
    select distinct
      case when m.sender_id = p_user_id then m.receiver_id
           else m.sender_id end as oid
    from public.messages m
    where m.group_id is null
      and (m.sender_id = p_user_id or m.receiver_id = p_user_id)
      and m.sender_id is not null
      and m.receiver_id is not null
  )
  select pr.id,
         pr.nickname,
         pr.phone,
         f.status,
         (
           select max(m2.created_at)
           from public.messages m2
           where m2.group_id is null
             and ((m2.sender_id = p_user_id and m2.receiver_id = pr.id)
               or  (m2.sender_id = pr.id and m2.receiver_id = p_user_id))
         ) as last_message_at
  from peers
  join public.profiles pr on pr.id = peers.oid
  left join public.friendships f
    on (f.requester_id = p_user_id and f.addressee_id = peers.oid)
    or (f.addressee_id = p_user_id and f.requester_id = peers.oid)
  where pr.id is not null
  order by last_message_at desc nulls last;
end;
$$;

grant execute on function public.gm_list_user_chat_peers(text, uuid) to authenticated;

select 'GM 已删除好友聊天查看（gm_list_user_chat_peers）已就绪' as result;
