-- ============================================================
--  用户编号（按注册顺序，注销后永久空缺、不复用）
--  用法：Supabase 控制台 → SQL Editor → 全文粘贴 → Run
--  可重复执行（幂等）
-- ============================================================
--
-- 设计要点：
--   1) 每个注册用户获得一个全局递增的 user_number（#1 为最早注册者）。
--   2) 新用户由触发器 handle_new_user 通过序列 user_number_seq 取号。
--   3) 注销账号是硬删除（delete_my_account 删 auth.users 级联删 profiles），
--      其编号随资料一起消失，且序列不会回退 / 重用 → 该编号永久空缺。
--   4) GM 授予 / 撤销称号的搜索结果按 user_number 升序排列，并回传编号。

-- 1) 列
alter table public.profiles add column if not exists user_number bigint;

-- 2) 序列（新注册用户取下一个号；不使用 max+1 以规避并发竞争）
create sequence if not exists public.user_number_seq;

-- 3) 回填存量用户：仅当还没有任何编号时，按注册时间（auth.users.created_at）升序分配 1,2,3…
do $$
begin
  if not exists (select 1 from public.profiles where user_number is not null) then
    with ordered as (
      select p.id,
             row_number() over (order by u.created_at asc, p.id asc) as rn
      from public.profiles p
      join auth.users u on u.id = p.id
    )
    update public.profiles p2
    set user_number = o.rn
    from ordered o
    where p2.id = o.id;
  end if;
end $$;

-- 4) 序列追上当前最大值（is_called=true → 下一次 nextval 返回 max+1；无用户时从 1 起）
select setval('public.user_number_seq',
              (select coalesce(max(user_number), 0) from public.profiles), true);

-- 5) 新用户注册时自动写入编号
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone, nickname, user_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'phone', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'nickname', '用户' || substr(new.id::text, 1, 4)),
    nextval('public.user_number_seq')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 6) GM 基础用户搜索（v223 在线状态）：返回 user_number，按编号升序
drop function if exists public.gm_search_users(text, text) cascade;
create or replace function public.gm_search_users(p_pwd text, p_query text)
returns table (
  id           uuid,
  phone        text,
  nickname     text,
  avatar_path  text,
  last_active  timestamptz,
  created_at   timestamptz,
  remark       text,
  user_number  bigint
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
            )),
           p.user_number
    from public.profiles p
    where (p_query is null or p_query = ''
           or p.phone ilike '%' || p_query || '%'
           or p.nickname ilike '%' || p_query || '%'
           or exists (select 1 from public.friendships fr
                       where (fr.addressee_id = p.id and fr.requester_remark ilike '%' || p_query || '%')
                          or (fr.requester_id = p.id and fr.addressee_remark ilike '%' || p_query || '%')))
    order by p.user_number asc nulls last
    limit 100;
end;
$$;
grant execute on function public.gm_search_users(text, text) to authenticated;

-- 7) GM 授予称号搜索：排除已获得者，返回 user_number，按编号升序
drop function if exists public.gm_search_users_for_title(text, text, uuid) cascade;
create or replace function public.gm_search_users_for_title(p_pwd text, p_query text, p_title_id uuid)
returns table (
  id           uuid,
  phone        text,
  nickname     text,
  avatar_path  text,
  last_active  timestamptz,
  created_at   timestamptz,
  remark       text,
  user_number  bigint
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
            )),
           p.user_number
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
    order by p.user_number asc nulls last
    limit 100;
end;
$$;
grant execute on function public.gm_search_users_for_title(text, text, uuid) to authenticated;

-- 8) GM 撤销称号搜索：只返回已获得者，返回 user_number，按编号升序
drop function if exists public.gm_search_users_with_title(text, text, uuid) cascade;
create or replace function public.gm_search_users_with_title(p_pwd text, p_query text, p_title_id uuid)
returns table (
  id           uuid,
  phone        text,
  nickname     text,
  avatar_path  text,
  last_active  timestamptz,
  created_at   timestamptz,
  remark       text,
  user_number  bigint
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
            )),
           p.user_number
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
    order by p.user_number asc nulls last
    limit 100;
end;
$$;
grant execute on function public.gm_search_users_with_title(text, text, uuid) to authenticated;

notify pgrst, 'reload schema';

select '用户编号（user_number）已就绪：存量用户按注册顺序回填，新用户自动取号，GM 授予/撤销按编号升序' as status;
