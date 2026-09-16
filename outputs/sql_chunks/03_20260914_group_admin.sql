-- ----------------------------------------------------------------------
-- ▼ 来源：supabase/migrations/20260914_group_admin.sql   （v276 群管理员 + v286 GM 设/撤管理员）
-- ----------------------------------------------------------------------
-- ============================================================
-- 群管理员（20260914）
--   群主可授予 / 剥夺「群管理员」；管理员可添加、踢出成员（不能踢群主、
--   不能踢其他管理员），可修改群名称；群头像仍仅群主可改。
--   在 group_members 增加 is_admin 列，并提供 set_group_admin RPC，
--   同时放宽 add_group_members / remove_group_member / update_group 的权限。
--   幂等：可重复执行（create or replace / add column if not exists）。
--   用法：Supabase 控制台 → SQL Editor → 全文粘贴 → Run
-- ============================================================

-- 1) group_members 增加 is_admin 列
alter table public.group_members
  add column if not exists is_admin boolean not null default false;

-- 2) 判断某用户是否为群主或管理员（供其余 RPC 复用）
drop function if exists public.is_group_admin_or_owner(uuid, uuid);
create function public.is_group_admin_or_owner(uid uuid, gid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.groups g where g.id = gid and g.owner_id = uid)
      or exists (select 1 from public.group_members gm where gm.group_id = gid and gm.user_id = uid and gm.is_admin)
$$;
grant execute on function public.is_group_admin_or_owner(uuid, uuid) to authenticated;

-- 3) 授予 / 剥夺群管理员：仅群主可操作；目标须为成员且不能是群主
drop function if exists public.set_group_admin(uuid, uuid, boolean);
create function public.set_group_admin(
  p_group_id uuid,
  p_user_id  uuid,
  p_is_admin boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.groups g where g.id = p_group_id and g.owner_id = auth.uid()
  ) then
    raise exception '只有群主可以管理管理员';
  end if;
  if not exists (
    select 1 from public.group_members m where m.group_id = p_group_id and m.user_id = p_user_id
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
grant execute on function public.set_group_admin(uuid, uuid, boolean) to authenticated;

-- 4) 添加群成员：群主或管理员均可加人
drop function if exists public.add_group_members(uuid, uuid[]);
create or replace function public.add_group_members(
  p_group_id  uuid,
  p_user_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_admin_or_owner(auth.uid(), p_group_id) then
    raise exception '只有群主或管理员可以添加成员';
  end if;
  insert into public.group_members (group_id, user_id)
  select p_group_id, u.user_id
  from unnest(coalesce(p_user_ids, '{}')) as u(user_id)
  where exists (select 1 from public.profiles pr where pr.id = u.user_id)
  on conflict do nothing;
end;
$$;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;

-- 5) 移除群成员 / 退出群聊：
--    群主可移除任何人（除自己）；管理员可移除普通成员（不能移除群主 / 其他管理员）；
--    普通成员只能移除自己。
drop function if exists public.remove_group_member(uuid, uuid);
create or replace function public.remove_group_member(
  p_group_id uuid,
  p_user_id  uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_is_owner boolean := exists (select 1 from public.groups g where g.id = p_group_id and g.owner_id = auth.uid());
  v_caller_is_admin boolean := exists (select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = auth.uid() and gm.is_admin);
  v_target_is_owner boolean := exists (select 1 from public.groups g where g.id = p_group_id and g.owner_id = p_user_id);
  v_target_is_admin boolean := exists (select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = p_user_id and gm.is_admin);
begin
  -- 群主不能移除自己（应先转让群主再退群）
  if v_caller_is_owner and p_user_id = auth.uid() then
    raise exception '你是群主，请先转让群主再退群';
  end if;
  -- 普通成员：只能移除自己
  if not v_caller_is_owner and not v_caller_is_admin then
    if p_user_id <> auth.uid() then
      raise exception '无权移除其他成员';
    end if;
    delete from public.group_members where group_id = p_group_id and user_id = p_user_id;
    return;
  end if;
  -- 以下：操作者 = 群主 或 管理员
  if v_target_is_owner then
    raise exception '不能移除群主';
  end if;
  if not v_caller_is_owner and v_target_is_admin then
    raise exception '只有群主可以移除其他管理员';
  end if;
  delete from public.group_members where group_id = p_group_id and user_id = p_user_id;
end;
$$;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;

-- 6) 修改群资料：群主或管理员可改名；群头像仅群主可改（管理员改名不动图标）
drop function if exists public.update_group(uuid, text);
drop function if exists public.update_group(uuid, text, text);
create function public.update_group(
  p_group_id     uuid,
  p_name         text,
  p_avatar_path  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_owner boolean := exists (select 1 from public.groups g where g.id = p_group_id and g.owner_id = auth.uid());
  v_is_admin boolean := exists (select 1 from public.group_members gm where gm.group_id = p_group_id and gm.user_id = auth.uid() and gm.is_admin);
begin
  if not (v_is_owner or v_is_admin) then
    raise exception '只有群主或管理员可以修改群资料';
  end if;
  update public.groups
     set name = coalesce(nullif(trim(p_name), ''), name),
         -- 群图标仅群主可改，管理员改名保持原图标
         avatar_path = case
                         when v_is_owner and p_avatar_path is not null then
                           case when trim(p_avatar_path) = '' then null else p_avatar_path end
                         else avatar_path
                       end
   where id = p_group_id;
end;
$$;
grant execute on function public.update_group(uuid, text, text) to authenticated;

-- 7) GM 后台成员列表：补全 is_admin（仅展示，GM 仍可按原逻辑管理）
drop function if exists public.gm_list_group_members(text, uuid) cascade;
create or replace function public.gm_list_group_members(p_pwd text, p_group_id uuid)
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
  perform public.gm_check(p_pwd);
  return query
    select p.id,
           p.nickname,
           p.phone,
           p.avatar_path,
           p.last_active,
           (g.owner_id = p.id) as is_owner,
           coalesce(gm.is_admin, false) as is_admin
    from public.group_members gm
    join public.groups g on g.id = gm.group_id
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id
    order by (g.owner_id = p.id) desc, (coalesce(gm.is_admin, false)) desc, p.nickname nulls last;
end;
$$;
grant execute on function public.gm_list_group_members(text, uuid) to authenticated;

-- 8) GM 后台：设置 / 取消群管理员（绕过「仅群主」限制，走 GM 口令校验；
--    目标须为成员且不能是群主）
drop function if exists public.gm_set_group_admin(text, uuid, uuid, boolean);
create function public.gm_set_group_admin(
  p_pwd      text,
  p_group_id uuid,
  p_user_id  uuid,
  p_is_admin boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  if not exists (
    select 1 from public.group_members m where m.group_id = p_group_id and m.user_id = p_user_id
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
grant execute on function public.gm_set_group_admin(text, uuid, uuid, boolean) to authenticated;

select '群管理员（set_group_admin / is_group_admin_or_owner / add_group_members / remove_group_member / update_group / gm_list_group_members / gm_set_group_admin）已就绪' as result;
