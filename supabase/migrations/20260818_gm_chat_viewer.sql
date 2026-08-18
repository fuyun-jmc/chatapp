-- ============================================================
--  20260818 GM 聊天记录查看器
--  开发者（GM）可在后台查看任意用户 / 群聊的完整聊天记录：
--    · 绕过本端删除 (deleted_by)
--    · 绕过撤回 (recalled)
--    · 绕过违禁词隐藏 (hidden_forbidden)
--    · 图片 / 视频 / 文件均以原始存储路径返回，前端用 signedUrl 解析展示
--  另：扩展 gm_search_groups，使其也能按「群内成员昵称 / 手机号」模糊搜索。
--  所有函数经 gm_check 双重校验（auth.uid() 须为 gm_admin_uid 且口令正确），
--  security definer。幂等，可重复执行（在 Supabase 控制台 SQL Editor 全文粘贴 → Run）。
-- ============================================================

-- 0) 扩展 gm_search_groups：同时支持按「群成员昵称 / 手机号」模糊搜索
--    签名不变 (text, text)，直接 create or replace，避免 cascade 风险。
create or replace function public.gm_search_groups(p_pwd text, p_query text)
returns table (
  group_id       uuid,
  name           text,
  owner_id       uuid,
  owner_nickname text,
  member_count   bigint,
  created_at     timestamptz,
  remark         text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
    select g.id,
           g.name,
           g.owner_id,
           op.nickname,
           (select count(*) from public.group_members gm where gm.group_id = g.id) as member_count,
           g.created_at,
           (select gr.remark
              from public.group_remarks gr
             where gr.group_id = g.id
               and gr.remark is not null and gr.remark <> ''
               and gr.remark ilike '%' || p_query || '%'
             limit 1)
    from public.groups g
    left join public.profiles op on op.id = g.owner_id
    where (p_query is null or p_query = ''
           or g.name ilike '%' || p_query || '%'
           or op.nickname ilike '%' || p_query || '%'
           or exists (select 1 from public.group_remarks gr where gr.group_id = g.id and gr.remark ilike '%' || p_query || '%')
           or exists (
             select 1
               from public.group_members gm
               join public.profiles mp on mp.id = gm.user_id
              where gm.group_id = g.id
                and (mp.nickname ilike '%' || p_query || '%'
                     or mp.phone ilike '%' || p_query || '%')
           ))
    order by g.created_at desc
    limit 100;
end;
$$;
grant execute on function public.gm_search_groups(text, text) to authenticated;

-- 1) 群聊消息（GM 视角，绕过删除 / 撤回 / 隐藏）
drop function if exists public.gm_get_group_messages(text, uuid) cascade;

create or replace function public.gm_get_group_messages(p_pwd text, p_group_id uuid)
returns table (
  id               bigint,
  sender_id        uuid,
  sender_name      text,
  receiver_id      uuid,
  group_id         uuid,
  kind             text,
  content          text,
  file_path        text,
  file_name        text,
  file_size        bigint,
  created_at       timestamptz,
  recalled         boolean,
  deleted_by       uuid[],
  hidden_forbidden boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
    select m.id,
           m.sender_id,
           sp.nickname,
           m.receiver_id,
           m.group_id,
           m.kind,
           m.content,
           m.file_path,
           m.file_name,
           m.file_size,
           m.created_at,
           m.recalled,
           m.deleted_by,
           m.hidden_forbidden
    from public.messages m
    left join public.profiles sp on sp.id = m.sender_id
    where m.group_id = p_group_id
    order by m.created_at asc;
end;
$$;
grant execute on function public.gm_get_group_messages(text, uuid) to authenticated;

-- 2) 私聊消息（GM 视角，两用户之间，绕过删除 / 撤回 / 隐藏）
drop function if exists public.gm_get_dm_messages(text, uuid, uuid) cascade;

create or replace function public.gm_get_dm_messages(p_pwd text, p_user_a uuid, p_user_b uuid)
returns table (
  id               bigint,
  sender_id        uuid,
  sender_name      text,
  receiver_id      uuid,
  group_id         uuid,
  kind             text,
  content          text,
  file_path        text,
  file_name        text,
  file_size        bigint,
  created_at       timestamptz,
  recalled         boolean,
  deleted_by       uuid[],
  hidden_forbidden boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
    select m.id,
           m.sender_id,
           sp.nickname,
           m.receiver_id,
           m.group_id,
           m.kind,
           m.content,
           m.file_path,
           m.file_name,
           m.file_size,
           m.created_at,
           m.recalled,
           m.deleted_by,
           m.hidden_forbidden
    from public.messages m
    left join public.profiles sp on sp.id = m.sender_id
    where m.group_id is null
      and ((m.sender_id = p_user_a and m.receiver_id = p_user_b)
        or (m.sender_id = p_user_b and m.receiver_id = p_user_a))
    order by m.created_at asc;
end;
$$;
grant execute on function public.gm_get_dm_messages(text, uuid, uuid) to authenticated;

select 'GM 聊天记录查看器（gm_search_groups 扩展 / gm_get_group_messages / gm_get_dm_messages）已就绪' as result;
