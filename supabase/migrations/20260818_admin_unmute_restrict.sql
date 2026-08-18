-- ============================================================
-- 2026-08-18 · 管理员禁言申诉权限收紧
-- 规则：被禁言的「管理员」用户，其申诉仅可由持有「开发者」称号者
--       通过（解除禁言）；其余管理员只能「驳回」，不能「解禁」。
--       GM 后台（绝对管理员 / root 开发者）本身即可解禁，符合「仅开发者」。
-- ============================================================

-- 判断当前登录用户是否持有「开发者」称号
create or replace function public.is_dev_user()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.user_titles ut
      join public.titles t on t.id = ut.title_id
     where ut.user_id = auth.uid()
       and t.name = '开发者'
  );
$$;
grant execute on function public.is_dev_user() to authenticated;

-- 判断指定用户是否持有「管理员」称号
create or replace function public.user_has_admin_title(p_uid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.user_titles ut
      join public.titles t on t.id = ut.title_id
     where ut.user_id = p_uid
       and t.name = '管理员'
  );
$$;
grant execute on function public.user_has_admin_title(uuid) to authenticated;

-- GM 列表也带上 is_admin 标记（便于前端展示，GM 本身始终可解禁）
create or replace function public.gm_list_mute_appeals(p_pwd text)
returns table(
  id uuid, user_id uuid, nickname text, phone text,
  reason text, status text, created_at timestamptz, is_admin boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
  select a.id, a.user_id, p.nickname, p.phone, a.reason, a.status, a.created_at,
         exists (
           select 1 from public.user_titles ut
           join public.titles t on t.id = ut.title_id
           where ut.user_id = a.user_id and t.name = '管理员'
         ) as is_admin
  from public.mute_appeals a
  join public.profiles p on p.id = a.user_id
  order by (a.status = 'pending') desc, a.created_at desc;
end;
$$;
grant execute on function public.gm_list_mute_appeals(text) to authenticated;

-- 管理员列表带上 is_admin 标记
create or replace function public.admin_list_mute_appeals()
returns table(
  id uuid, user_id uuid, nickname text, phone text,
  reason text, status text, created_at timestamptz, reviewed_at timestamptz,
  is_admin boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_user() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;
  return query
    select a.id, a.user_id, p.nickname, p.phone, a.reason, a.status, a.created_at, a.reviewed_at,
           exists (
             select 1 from public.user_titles ut
             join public.titles t on t.id = ut.title_id
             where ut.user_id = a.user_id and t.name = '管理员'
           ) as is_admin
    from public.mute_appeals a
    join public.profiles p on p.id = a.user_id
    order by (a.status = 'pending') desc, a.created_at desc;
end;
$$;
grant execute on function public.admin_list_mute_appeals() to authenticated;

-- 核心：审核申诉时，目标为「管理员」则仅开发者可解除其禁言
create or replace function public.admin_review_mute_appeal(p_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid;
begin
  if not public.is_admin_user() then
    raise exception 'ADMIN_FORBIDDEN';
  end if;
  select user_id into v_uid from public.mute_appeals where id = p_id;
  if v_uid is null then
    raise exception 'NOT_FOUND';
  end if;
  if p_action = 'approve' and v_uid = auth.uid() then
    raise exception 'CANNOT_UNMUTE_SELF';
  end if;
  -- 目标为管理员时，仅开发者可解除其禁言（其余管理员只能驳回）
  if p_action = 'approve' and public.user_has_admin_title(v_uid)
     and not public.is_dev_user() then
    raise exception 'ONLY_DEV_CAN_UNMUTE_ADMIN';
  end if;
  if p_action = 'approve' then
    update public.profiles set muted_until = null where id = v_uid;
    update public.mute_appeals
       set status = 'approved', reviewed_at = now(), reviewer = 'admin'
     where id = p_id;
  elsif p_action = 'reject' then
    update public.mute_appeals
       set status = 'rejected', reviewed_at = now(), reviewer = 'admin'
     where id = p_id;
  else
    raise exception 'BAD_ACTION';
  end if;
end;
$$;
grant execute on function public.admin_review_mute_appeal(uuid, text) to authenticated;

select '管理员禁言申诉权限收紧已就绪（仅开发者可解除管理员禁言）';
