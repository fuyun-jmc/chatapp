-- ============================================================================
--  v296：群聊邀请码（半永久 8 位）
--   1) 群主可开启 / 关闭；开启时自动生成 8 位邀请码，同一群的码固定不变
--      （反复开关也复用同一个码），群解散后随群记录一并消失。
--   2) 群内任意成员都能看到并复制邀请码（群主额外有启用 / 关闭开关）。
--   3) 任何登录用户在「添加好友」搜索框输入该 8 位码即可直接进群，无需申请。
--  幂等可重跑。
-- ============================================================================

alter table public.groups
  add column if not exists invite_code    text,
  add column if not exists invite_enabled boolean not null default false;

-- 同一时刻不允许两个群持有相同邀请码
create unique index if not exists groups_invite_code_uq
  on public.groups (invite_code)
  where invite_code is not null;

-- ---------------------------------------------------------------------------
-- 生成 8 位候选码：[2-9a-hj-np-z]（去掉 0/1/i/l/o 等易混字符），小写
-- ---------------------------------------------------------------------------
create or replace function public.gen_group_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_alphabet text := '23456789abcdefghjkmnpqrstuvwxyz';
  v_out text := '';
  v_i  int;
begin
  for v_i in 1..8 loop
    v_out := v_out || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 群主：启用 / 关闭邀请码。返回当前邀请码（关闭返回 null）
-- ---------------------------------------------------------------------------
create or replace function public.set_group_invite(p_group_id uuid, p_enable boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
  v_try  text;
  v_i    int := 0;
begin
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  if not exists (
    select 1 from public.groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'NOT_OWNER';
  end if;

  select g.invite_code into v_code from public.groups g where g.id = p_group_id;

  if p_enable then
    if v_code is null then
      loop
        v_try := public.gen_group_invite_code();
        exit when not exists (select 1 from public.groups g where g.invite_code = v_try);
        v_i := v_i + 1;
        if v_i > 50 then
          raise exception 'INVITE_GEN_FAIL';
        end if;
      end loop;
      v_code := v_try;
    end if;
    update public.groups
       set invite_code = v_code, invite_enabled = true
     where id = p_group_id;
    return v_code;
  else
    -- 关闭：保留原码，下次开启仍复用同一码
    update public.groups set invite_enabled = false where id = p_group_id;
    return null;
  end if;
end;
$$;
grant execute on function public.set_group_invite(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 群成员读取邀请码（普通成员也能看到以便复制）
-- ---------------------------------------------------------------------------
create or replace function public.get_group_invite(p_group_id uuid)
returns table (invite_code text, invite_enabled boolean, i_am_owner boolean)
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  if not exists (
    select 1 from public.group_members gm
     where gm.group_id = p_group_id and gm.user_id = v_uid
  ) then
    raise exception 'NOT_MEMBER';
  end if;
  return query
  select case when g.invite_enabled then g.invite_code else null end,
         g.invite_enabled,
         g.owner_id = v_uid
  from public.groups g
  where g.id = p_group_id;
end;
$$;
grant execute on function public.get_group_invite(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 凭邀请码入群（无需申请、无需好友关系）
-- ---------------------------------------------------------------------------
create or replace function public.join_group_by_invite(p_code text)
returns table (group_id uuid, group_name text, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := lower(trim(coalesce(p_code, '')));
  v_gid  uuid;
  v_name text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  if v_code = '' then
    raise exception 'CODE_EMPTY';
  end if;

  select g.id, g.name into v_gid, v_name
    from public.groups g
   where g.invite_code = v_code
     and g.invite_enabled is true
   limit 1;

  if v_gid is null then
    raise exception 'INVITE_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.group_members gm
     where gm.group_id = v_gid and gm.user_id = v_uid
  ) then
    return query select v_gid, v_name, 'already_member'::text;
    return;
  end if;

  insert into public.group_members(group_id, user_id) values (v_gid, v_uid);

  -- 建立已读游标，避免把入群前的历史消息算成未读
  insert into public.conversation_reads(user_id, peer_id, is_group, last_read_at)
  values (v_uid, v_gid, true, now())
  on conflict (user_id, peer_id, is_group) do nothing;

  return query select v_gid, v_name, 'joined'::text;
end;
$$;
grant execute on function public.join_group_by_invite(text) to authenticated;

notify pgrst, 'reload schema';
