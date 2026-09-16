-- ============================================================
--  v291：次级开发者可被开发者授予 + 次级开发者可进入「简易 GM 后台」
--  授权模型：
--    admin  = 站长（gm_admin_uid()）
--    dev    = 持有「开发者」称号
--    subdev = 持有「次级开发者」称号
--  简易后台开放给 dev / subdev（额外包含 admin），仅提供四项能力：
--    ① 查看全部用户在线状态  ② 注销用户账号
--    ③ 查看群聊状态          ④ 修改群聊群主 / 管理员
--  安全兜底：站长与「开发者」为受保护账号，subdev 不能注销他们、
--            也不能授予 / 撤销他们身上的次级开发者称号。
-- ============================================================

-- 1) 角色判定（不校验口令，纯查询当前登录者的后台身份）
create or replace function public.gm2_role()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_res text;
begin
  v_uid := auth.uid();
  if v_uid is null then return null; end if;
  if (v_uid::uuid) is not distinct from public.gm_admin_uid() then
    return 'admin';
  end if;
  select case
           when bool_or(t.name = '开发者')     then 'dev'
           when bool_or(t.name = '次级开发者') then 'subdev'
         end
    into v_res
    from public.user_titles ut
    join public.titles t on t.id = ut.title_id
   where ut.user_id = v_uid
     and t.name in ('开发者', '次级开发者');
  return v_res;   -- 没有任何开发者类称号时返回 null
end;
$$;
grant execute on function public.gm2_role() to authenticated;

-- 2) 统一鉴权：返回本次调用者的角色，无权/口令错直接抛异常
create or replace function public.gm2_auth(p_pwd text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if p_pwd is distinct from public.gm_password() then
    raise exception 'GM_AUTH_FAIL';
  end if;
  v_role := public.gm2_role();
  if v_role is null then
    raise exception 'GM_FORBIDDEN';
  end if;
  return v_role;
end;
$$;
grant execute on function public.gm2_auth(text) to authenticated;

create or replace function public.gm2_check(p_pwd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_auth(p_pwd);
end;
$$;
grant execute on function public.gm2_check(text) to authenticated;

-- 3) 受保护账号：站长 + 所有「开发者」（subdev 不可动）
create or replace function public.gm2_protected(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select (p_user_id::uuid is not distinct from public.gm_admin_uid())
      or exists (
           select 1
             from public.user_titles ut
             join public.titles t on t.id = ut.title_id
            where ut.user_id = p_user_id
              and t.name = '开发者'
         );
$$;
grant execute on function public.gm2_protected(uuid) to authenticated;

-- 4) 开发者（及以上）授予 / 撤销「次级开发者」称号
create or replace function public.dev_grant_subdev(p_pwd text, p_user_id uuid, p_grant boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_tid  uuid;
begin
  v_role := public.gm2_auth(p_pwd);
  if v_role not in ('admin', 'dev') then
    raise exception 'DEV_ONLY';
  end if;
  if p_user_id is null then raise exception '缺少目标用户'; end if;
  if (p_user_id::uuid) is not distinct from (auth.uid()::uuid) then
    raise exception '不能对自己执行该操作';
  end if;
  if v_role <> 'admin' and public.gm2_protected(p_user_id) then
    raise exception '该账号受保护，仅站长可操作';
  end if;

  select id into v_tid from public.titles where name = '次级开发者' limit 1;
  if v_tid is null then
    raise exception '称号「次级开发者」不存在，请先执行 v289 迁移（20260915_sub_developer_title.sql）';
  end if;

  if coalesce(p_grant, true) then
    insert into public.user_titles (user_id, title_id, source, granted_by)
    values (p_user_id, v_tid, 'manual', auth.uid())
    on conflict (user_id, title_id) do nothing;
  else
    delete from public.user_titles
     where user_id = p_user_id and title_id = v_tid;
  end if;
end;
$$;
grant execute on function public.dev_grant_subdev(text, uuid, boolean) to authenticated;

-- 5) 用户列表（含在线状态 / 角色）
drop function if exists public.gm2_list_users(text, text) cascade;

create or replace function public.gm2_list_users(p_pwd text, p_query text)
returns table (
  id          uuid,
  phone       text,
  nickname    text,
  avatar_path text,
  last_active timestamptz,
  created_at  timestamptz,
  user_number bigint,
  roles       text,
  is_subdev   boolean,
  is_protected boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  return query
    select p.id,
           p.phone,
           p.nickname,
           p.avatar_path,
           p.last_active,
           p.created_at,
           p.user_number,
           (select string_agg(t.name, '、' order by t.name)
              from public.user_titles ut
              join public.titles t on t.id = ut.title_id
             where ut.user_id = p.id
               and t.name in ('开发者', '次级开发者', '管理员')),
           exists (select 1
                     from public.user_titles ut
                     join public.titles t on t.id = ut.title_id
                    where ut.user_id = p.id and t.name = '次级开发者'),
           public.gm2_protected(p.id)
      from public.profiles p
     where (p_query is null or p_query = ''
            or p.phone ilike '%' || p_query || '%'
            or p.nickname ilike '%' || p_query || '%'
            or (p.user_number is not null and p.user_number::text = p_query))
     order by p.user_number asc nulls last
     limit 200;
end;
$$;
grant execute on function public.gm2_list_users(text, text) to authenticated;

-- 6) 注销用户账号（受保护账号需站长权限）
create or replace function public.gm2_delete_account(p_pwd text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
begin
  v_role := public.gm2_auth(p_pwd);
  if p_user_id is null then raise exception '缺少目标用户'; end if;
  if (p_user_id::uuid) is not distinct from (auth.uid()::uuid) then
    raise exception '不能注销当前登录账号';
  end if;
  if v_role <> 'admin' and public.gm2_protected(p_user_id) then
    raise exception '该账号受保护，仅站长可注销';
  end if;

  delete from public.user_titles        where user_id = p_user_id;
  delete from public.group_members      where user_id = p_user_id;
  delete from public.device_sessions    where user_id = p_user_id;
  delete from public.friendships        where requester_id = p_user_id or addressee_id = p_user_id;

  -- identities / mfa_factors 等表在部分实例上不存在，逐条容错删除
  begin
    delete from auth.identities    where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;
  begin
    delete from auth.mfa_factors   where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;
  begin
    delete from auth.refresh_tokens where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;
  begin
    delete from auth.sessions      where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;

  delete from auth.users where id::text = p_user_id::text;
  delete from public.profiles where id = p_user_id;
end;
$$;
grant execute on function public.gm2_delete_account(text, uuid) to authenticated;

-- 7) 群聊列表（含成员数 / 群主 / 状态）
drop function if exists public.gm2_list_groups(text, text) cascade;

create or replace function public.gm2_list_groups(p_pwd text, p_query text)
returns table (
  group_id       uuid,
  name           text,
  owner_id       uuid,
  owner_nickname text,
  owner_online   boolean,
  member_count   bigint,
  admin_count    bigint,
  created_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  return query
    select g.id,
           g.name,
           g.owner_id,
           op.nickname,
           (op.last_active is not null and op.last_active > now() - interval '2 minutes'),
           (select count(*) from public.group_members m where m.group_id = g.id),
           (select count(*) from public.group_members m where m.group_id = g.id and m.is_admin),
           g.created_at
      from public.groups g
      left join public.profiles op on op.id = g.owner_id
     where (p_query is null or p_query = ''
            or g.name ilike '%' || p_query || '%'
            or op.nickname ilike '%' || p_query || '%')
     order by g.created_at desc
     limit 200;
end;
$$;
grant execute on function public.gm2_list_groups(text, text) to authenticated;

-- 8) 群成员列表（含在线 / 管理员状态）
drop function if exists public.gm2_list_group_members(text, uuid) cascade;

create or replace function public.gm2_list_group_members(p_pwd text, p_group_id uuid)
returns table (
  user_id     uuid,
  nickname    text,
  phone       text,
  avatar_path text,
  last_active timestamptz,
  is_owner    boolean,
  is_admin    boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  return query
    select p.id,
           p.nickname,
           p.phone,
           p.avatar_path,
           p.last_active,
           (g.owner_id = p.id),
           coalesce(m.is_admin, false)
      from public.group_members m
      join public.groups g    on g.id = m.group_id
      join public.profiles p  on p.id = m.user_id
     where m.group_id = p_group_id
     order by (g.owner_id = p.id) desc, coalesce(m.is_admin, false) desc, p.nickname nulls last;
end;
$$;
grant execute on function public.gm2_list_group_members(text, uuid) to authenticated;

-- 9) 修改群主（新群主必须是群成员）
create or replace function public.gm2_set_group_owner(p_pwd text, p_group_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.user_id = p_new_owner_id
  ) then
    raise exception '新群主必须是该群成员';
  end if;
  update public.groups set owner_id = p_new_owner_id where id = p_group_id;
  update public.group_members set is_admin = false
   where group_id = p_group_id and user_id = p_new_owner_id;
end;
$$;
grant execute on function public.gm2_set_group_owner(text, uuid, uuid) to authenticated;

-- 10) 设置 / 取消群管理员
create or replace function public.gm2_set_group_admin(p_pwd text, p_group_id uuid, p_user_id uuid, p_is_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.user_id = p_user_id
  ) then
    raise exception '该用户不是群成员';
  end if;
  if exists (
    select 1 from public.groups g where g.id = p_group_id and g.owner_id = p_user_id
  ) then
    raise exception '群主默认拥有管理员权限，无需设置';
  end if;
  update public.group_members
     set is_admin = coalesce(p_is_admin, false)
   where group_id = p_group_id and user_id = p_user_id;
end;
$$;
grant execute on function public.gm2_set_group_admin(text, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
