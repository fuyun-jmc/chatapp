-- GM 称号授予/撤销搜索整理 + 授予时排除已获得者二次兜底
-- 合并 20260806/20260807 两个迁移，并新增 gm_get_title_holders 供前端二次过滤。

drop function if exists public.gm_search_users_for_title(text, text, uuid) cascade;

create or replace function public.gm_search_users_for_title(p_pwd text, p_query text, p_title_id uuid)
returns table (
  id           uuid,
  phone        text,
  nickname     text,
  avatar_path  text,
  last_active  timestamptz,
  created_at   timestamptz,
  remark       text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
    select p.id, p.phone, p.nickname, p.avatar_path, p.last_active, p.created_at,
           (select coalesce(
              (select fr.requester_remark
                 from public.friendships fr
                where fr.addressee_id = p.id
                  and fr.requester_remark is not null and fr.requester_remark <> ''
                  and fr.requester_remark ilike '%' || p_query || '%'
                limit 1),
              (select fr.addressee_remark
                 from public.friendships fr
                where fr.requester_id = p.id
                  and fr.addressee_remark is not null and fr.addressee_remark <> ''
                  and fr.addressee_remark ilike '%' || p_query || '%'
                limit 1)
            ))
    from public.profiles p
    where not exists (
      select 1 from public.user_titles ut
      where ut.user_id = p.id and ut.title_id = p_title_id
    )
      and (p_query is null or p_query = ''
           or p.phone ilike '%' || p_query || '%'
           or p.nickname ilike '%' || p_query || '%'
           or exists (select 1 from public.friendships fr
                       where (fr.addressee_id = p.id and fr.requester_remark ilike '%' || p_query || '%')
                          or (fr.requester_id = p.id and fr.addressee_remark ilike '%' || p_query || '%')))
    order by
      (case
         when p.phone = p_query then 0
         when p.phone ilike p_query || '%' then 1
         when p.nickname ilike p_query || '%' then 2
         when p.nickname ilike '%' || p_query || '%' then 3
         else 4
       end),
      p.created_at desc
    limit 100;
end;
$$;
grant execute on function public.gm_search_users_for_title(text, text, uuid) to authenticated;

drop function if exists public.gm_search_users_with_title(text, text, uuid) cascade;

create or replace function public.gm_search_users_with_title(p_pwd text, p_query text, p_title_id uuid)
returns table (
  id           uuid,
  phone        text,
  nickname     text,
  avatar_path  text,
  last_active  timestamptz,
  created_at   timestamptz,
  remark       text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
    select p.id, p.phone, p.nickname, p.avatar_path, p.last_active, p.created_at,
           (select coalesce(
              (select fr.requester_remark
                 from public.friendships fr
                where fr.addressee_id = p.id
                  and fr.requester_remark is not null and fr.requester_remark <> ''
                  and fr.requester_remark ilike '%' || p_query || '%'
                limit 1),
              (select fr.addressee_remark
                 from public.friendships fr
                where fr.requester_id = p.id
                  and fr.addressee_remark is not null and fr.addressee_remark <> ''
                  and fr.addressee_remark ilike '%' || p_query || '%'
                limit 1)
            ))
    from public.profiles p
    where exists (
      select 1 from public.user_titles ut
      where ut.user_id = p.id and ut.title_id = p_title_id
    )
      and (p_query is null or p_query = ''
           or p.phone ilike '%' || p_query || '%'
           or p.nickname ilike '%' || p_query || '%'
           or exists (select 1 from public.friendships fr
                       where (fr.addressee_id = p.id and fr.requester_remark ilike '%' || p_query || '%')
                          or (fr.requester_id = p.id and fr.addressee_remark ilike '%' || p_query || '%')))
    order by
      (case
         when p.phone = p_query then 0
         when p.phone ilike p_query || '%' then 1
         when p.nickname ilike p_query || '%' then 2
         when p.nickname ilike '%' || p_query || '%' then 3
         else 4
       end),
      p.created_at desc
    limit 100;
end;
$$;
grant execute on function public.gm_search_users_with_title(text, text, uuid) to authenticated;

-- 新增：返回某称号全部获得者 ID，供前端授予搜索做二次兜底过滤
create or replace function public.gm_get_title_holders(p_pwd text, p_title_id uuid)
returns table (user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
    select ut.user_id
    from public.user_titles ut
    where ut.title_id = p_title_id;
end;
$$;
grant execute on function public.gm_get_title_holders(text, uuid) to authenticated;

notify pgrst, 'reload schema';

select 'GM 称号授予/撤销搜索 + 持有者查询 RPC 已就绪' as status;
