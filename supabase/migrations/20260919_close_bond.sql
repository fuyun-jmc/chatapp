-- ============================================================================
--  v299：亲密关系绑定
--   · 预设关系：cp / 兄弟 / 闺蜜 / 挚友 / 死党（GM 可在后台新增自定义类型）
--   · 聊天页「关系」按钮发起绑定申请 → 对方通过后正式绑定
--   · GM 后台 / 管理后台可强制绑定、解除、改亲密度、管理类型
--   · 每条单聊消息双方亲密度 +1（触发器）
--   · 关系与亲密度仅绑定双方可见（RLS）；GM RPC 走 gm_check
--  幂等可重跑。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 关系类型表（预设 + GM 自定义）
-- ---------------------------------------------------------------------------
create table if not exists public.bond_types (
  name       text primary key,
  icon       text not null default '💞',
  color      text not null default '#e0245e',
  sort       int  not null default 100,
  is_preset  boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.bond_types(name, icon, color, sort, is_preset) values
  ('cp',   '💞', '#e0245e', 1, true),
  ('兄弟', '🤝', '#3b82f6', 2, true),
  ('闺蜜', '👭', '#d946ef', 3, true),
  ('挚友', '⭐', '#f59e0b', 4, true),
  ('死党', '🔥', '#ef4444', 5, true)
on conflict (name) do nothing;

alter table public.bond_types enable row level security;
drop policy if exists "bond_types_select" on public.bond_types;
create policy "bond_types_select" on public.bond_types
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. 绑定关系表（仅已通过；一对用户同时只绑定一种关系）
-- ---------------------------------------------------------------------------
create table if not exists public.close_bonds (
  id         uuid primary key default gen_random_uuid(),
  bond_type  text not null references public.bond_types(name) on delete restrict,
  user_a     uuid not null references auth.users(id) on delete cascade,
  user_b     uuid not null references auth.users(id) on delete cascade,
  intimacy   int not null default 0,
  bound_by   uuid references auth.users(id) on delete set null,  -- GM 强制绑定时记录操作者
  created_at timestamptz not null default now(),
  unique (user_a, user_b),
  check (user_a <> user_b)
);
create index if not exists close_bonds_a_idx on public.close_bonds (user_a);
create index if not exists close_bonds_b_idx on public.close_bonds (user_b);

alter table public.close_bonds enable row level security;
drop policy if exists "close_bonds_select" on public.close_bonds;
create policy "close_bonds_select" on public.close_bonds
  for select to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

-- ---------------------------------------------------------------------------
-- 3. 绑定申请表（pending → 接受建 bond / 拒绝删记录）
-- ---------------------------------------------------------------------------
create table if not exists public.bond_requests (
  id         uuid primary key default gen_random_uuid(),
  from_user  uuid not null references auth.users(id) on delete cascade,
  to_user    uuid not null references auth.users(id) on delete cascade,
  bond_type  text not null references public.bond_types(name) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  check (from_user <> to_user)
);
-- 同一对用户同一方向同时只能有一条待处理申请
create unique index if not exists bond_requests_pending_uq
  on public.bond_requests (from_user, to_user) where status = 'pending';
create index if not exists bond_requests_to_idx on public.bond_requests (to_user);
create index if not exists bond_requests_from_idx on public.bond_requests (from_user);

alter table public.bond_requests enable row level security;
drop policy if exists "bond_requests_select" on public.bond_requests;
create policy "bond_requests_select" on public.bond_requests
  for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

-- ---------------------------------------------------------------------------
-- 4. 亲密度触发器：每条单聊消息 +1（上限 9999999）
-- ---------------------------------------------------------------------------
create or replace function public.bond_bump_intimacy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a uuid; v_b uuid;
begin
  if new.group_id is not null or new.receiver_id is null then
    return new;
  end if;
  v_a := least(new.sender_id, new.receiver_id);
  v_b := greatest(new.sender_id, new.receiver_id);
  update public.close_bonds
     set intimacy = least(intimacy + 1, 9999999)
   where user_a = v_a and user_b = v_b;
  return new;
end;
$$;

drop trigger if exists bond_bump_intimacy_trg on public.messages;
create trigger bond_bump_intimacy_trg
  after insert on public.messages
  for each row execute function public.bond_bump_intimacy();

-- ---------------------------------------------------------------------------
-- 5. 用户侧 RPC
-- ---------------------------------------------------------------------------
-- 关系类型列表
create or replace function public.bond_list_types()
returns table (name text, icon text, color text, sort int, is_preset boolean)
language sql
stable
security definer
set search_path = public
as $$
  select b.name, b.icon, b.color, b.sort, b.is_preset
    from public.bond_types b
   order by b.sort asc, b.name asc;
$$;
grant execute on function public.bond_list_types() to authenticated;

-- 我和某人的关系状态：已绑定 / 我发出的待处理申请 / 对方发来的待处理申请
create or replace function public.bond_status(p_user_id uuid)
returns table (
  bond_type text, icon text, color text, intimacy int, bound_at timestamptz,
  pending_out boolean, pending_in boolean, request_id uuid, request_type text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid; v_b uuid;
begin
  if v_uid is null or p_user_id is null or p_user_id = v_uid then
    return;
  end if;
  v_a := least(v_uid, p_user_id);
  v_b := greatest(v_uid, p_user_id);

  return query
  select cb.bond_type, t.icon, t.color, cb.intimacy, cb.created_at,
         false::boolean, false::boolean, null::uuid, null::text
    from public.close_bonds cb
    join public.bond_types t on t.name = cb.bond_type
   where cb.user_a = v_a and cb.user_b = v_b;
  if found then return; end if;

  return query
  select null::text, null::text, null::text, null::int, null::timestamptz,
         (br.from_user = v_uid), (br.to_user = v_uid), br.id, br.bond_type
    from public.bond_requests br
    join public.bond_types t on t.name = br.bond_type
   where br.status = 'pending'
     and ((br.from_user = v_uid and br.to_user = p_user_id)
       or (br.to_user = v_uid and br.from_user = p_user_id))
   limit 1;
end;
$$;
grant execute on function public.bond_status(uuid) to authenticated;

-- 发起绑定申请（须为好友；未绑定且无待处理申请）
create or replace function public.bond_request(p_user_id uuid, p_type text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid; v_b uuid;
  v_req uuid;
begin
  if v_uid is null or p_user_id is null or p_user_id = v_uid then
    raise exception 'BOND_BAD_TARGET';
  end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and ((f.requester_id = v_uid and f.addressee_id = p_user_id)
         or (f.requester_id = p_user_id and f.addressee_id = v_uid))
  ) then
    raise exception 'BOND_NOT_FRIEND';
  end if;
  if not exists (select 1 from public.bond_types where name = p_type) then
    raise exception 'BOND_BAD_TYPE';
  end if;
  v_a := least(v_uid, p_user_id);
  v_b := greatest(v_uid, p_user_id);
  if exists (select 1 from public.close_bonds where user_a = v_a and user_b = v_b) then
    raise exception 'BOND_EXISTS';
  end if;
  if exists (
    select 1 from public.bond_requests
     where status = 'pending'
       and ((from_user = v_uid and to_user = p_user_id)
         or (to_user = v_uid and from_user = p_user_id))
  ) then
    raise exception 'BOND_PENDING_EXISTS';
  end if;

  insert into public.bond_requests(from_user, to_user, bond_type)
  values (v_uid, p_user_id, p_type)
  returning id into v_req;
  return v_req;
end;
$$;
grant execute on function public.bond_request(uuid, text) to authenticated;

-- 处理收到的申请：同意 → 建立绑定并清掉该对的全部待处理申请；拒绝 → 删除申请
create or replace function public.bond_respond(p_request_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  r public.bond_requests%rowtype;
  v_a uuid; v_b uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  select * into r from public.bond_requests
   where id = p_request_id and to_user = v_uid and status = 'pending';
  if not found then raise exception 'BOND_REQ_NOT_FOUND'; end if;

  v_a := least(r.from_user, r.to_user);
  v_b := greatest(r.from_user, r.to_user);

  if coalesce(p_accept, false) then
    insert into public.close_bonds(bond_type, user_a, user_b)
    values (r.bond_type, v_a, v_b)
    on conflict (user_a, user_b) do update
      set bond_type = excluded.bond_type;
    delete from public.bond_requests
     where status = 'pending'
       and ((from_user = v_a and to_user = v_b)
         or (from_user = v_b and to_user = v_a));
  else
    delete from public.bond_requests where id = r.id;
  end if;
end;
$$;
grant execute on function public.bond_respond(uuid, boolean) to authenticated;

-- 撤回我发出的待处理申请
create or replace function public.bond_cancel(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.bond_requests
   where from_user = auth.uid() and to_user = p_user_id and status = 'pending';
$$;
grant execute on function public.bond_cancel(uuid) to authenticated;

-- 解除绑定（任一方可解）
create or replace function public.bond_unbind(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.close_bonds
   where user_a = least(auth.uid(), p_user_id)
     and user_b = greatest(auth.uid(), p_user_id);
$$;
grant execute on function public.bond_unbind(uuid) to authenticated;

-- 我的所有绑定（好友列表 / 个人主页徽标用，仅含自己的）
create or replace function public.bond_my_bonds()
returns table (
  other_id uuid, bond_type text, icon text, color text,
  intimacy int, bound_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select case when cb.user_a = auth.uid() then cb.user_b else cb.user_a end,
         cb.bond_type, t.icon, t.color, cb.intimacy, cb.created_at
    from public.close_bonds cb
    join public.bond_types t on t.name = cb.bond_type
   where cb.user_a = auth.uid() or cb.user_b = auth.uid();
$$;
grant execute on function public.bond_my_bonds() to authenticated;

-- 我收到的待处理绑定申请
create or replace function public.bond_pending_in()
returns table (
  request_id uuid, from_user uuid, bond_type text, icon text, color text, created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select br.id, br.from_user, br.bond_type, t.icon, t.color, br.created_at
    from public.bond_requests br
    join public.bond_types t on t.name = br.bond_type
   where br.to_user = auth.uid() and br.status = 'pending'
   order by br.created_at desc;
$$;
grant execute on function public.bond_pending_in() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. GM RPC（gm_check 鉴权：站长凭口令，开发者/次级开发者免密）
-- ---------------------------------------------------------------------------
-- 强制绑定（已绑定时改为改类型；同时清掉该对全部待处理申请）
create or replace function public.gm_bond_force(p_pwd text, p_user_a uuid, p_user_b uuid, p_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_a uuid; v_b uuid;
begin
  perform public.gm_check(p_pwd);
  if p_user_a is null or p_user_b is null or p_user_a = p_user_b then
    raise exception 'BOND_BAD_TARGET';
  end if;
  if not exists (select 1 from public.bond_types where name = p_type) then
    raise exception 'BOND_BAD_TYPE';
  end if;
  v_a := least(p_user_a, p_user_b);
  v_b := greatest(p_user_a, p_user_b);
  insert into public.close_bonds(bond_type, user_a, user_b, bound_by)
  values (p_type, v_a, v_b, auth.uid())
  on conflict (user_a, user_b) do update
    set bond_type = excluded.bond_type,
        bound_by  = auth.uid();
  delete from public.bond_requests
   where status = 'pending'
     and ((from_user = v_a and to_user = v_b)
       or (from_user = v_b and to_user = v_a));
end;
$$;
grant execute on function public.gm_bond_force(text, uuid, uuid, text) to authenticated;

-- 强制解除（连带清申请）
create or replace function public.gm_bond_remove(p_pwd text, p_user_a uuid, p_user_b uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.close_bonds
   where user_a = least(p_user_a, p_user_b) and user_b = greatest(p_user_a, p_user_b);
  delete from public.bond_requests
   where status = 'pending'
     and ((from_user = least(p_user_a, p_user_b) and to_user = greatest(p_user_a, p_user_b))
       or (from_user = greatest(p_user_a, p_user_b) and to_user = least(p_user_a, p_user_b)));
$$;
grant execute on function public.gm_bond_remove(text, uuid, uuid) to authenticated;

-- 设置亲密度
create or replace function public.gm_bond_set_intimacy(p_pwd text, p_user_a uuid, p_user_b uuid, p_value int)
returns void
language sql
security definer
set search_path = public
as $$
  update public.close_bonds
     set intimacy = greatest(0, least(coalesce(p_value, 0), 9999999))
   where user_a = least(p_user_a, p_user_b) and user_b = greatest(p_user_a, p_user_b);
$$;
grant execute on function public.gm_bond_set_intimacy(text, uuid, uuid, int) to authenticated;

-- 全部绑定列表（GM 后台管理用）
create or replace function public.gm_bond_list(p_pwd text)
returns table (
  bond_type text, icon text, color text, intimacy int, created_at timestamptz,
  a_id uuid, a_name text, a_phone text,
  b_id uuid, b_name text, b_phone text,
  bound_by_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select cb.bond_type, t.icon, t.color, cb.intimacy, cb.created_at,
         pa.id, pa.nickname, pa.phone,
         pb.id, pb.nickname, pb.phone,
         pg.nickname
    from public.close_bonds cb
    join public.bond_types t on t.name = cb.bond_type
    join public.profiles pa on pa.id = cb.user_a
    join public.profiles pb on pb.id = cb.user_b
    left join public.profiles pg on pg.id = cb.bound_by
   order by cb.created_at desc
   limit 300;
$$;
grant execute on function public.gm_bond_list(text) to authenticated;

-- 新增自定义关系类型（GM）
create or replace function public.gm_bond_add_type(p_pwd text, p_name text, p_icon text, p_color text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.bond_types(name, icon, color, sort, is_preset)
  values (left(trim(p_name), 12),
          coalesce(nullif(trim(p_icon), ''), '💞'),
          coalesce(nullif(trim(p_color), ''), '#e0245e'),
          200, false)
  on conflict (name) do update
    set icon = excluded.icon, color = excluded.color;
$$;
grant execute on function public.gm_bond_add_type(text, text, text, text) to authenticated;

-- 删除非预设类型（有绑定在用时由 FK restrict 报错，前端提示）
create or replace function public.gm_bond_del_type(p_pwd text, p_name text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.bond_types where name = p_name and is_preset = false;
$$;
grant execute on function public.gm_bond_del_type(text, text) to authenticated;

notify pgrst, 'reload schema';
