-- ============================================================================
--  好友码功能（v243）
--  用法：Supabase 控制台 → SQL Editor → 全文粘贴 → Run。可重复执行（幂等）。
--
--  设计要点：
--   1) 好友码 8 位，仅含数字 + 小写字母。
--   2) 永久好友码：每用户一个，永不重复（唯一约束保证）。
--   3) 临时好友码：启用时随机生成一个；使用一次后失效，并自动生成下一个；
--      临时码与「任意永久码 / 任意其他用户当前临时码」全局唯一，绝不重复。
--   4) 好友码仅本人可见：存于独立表 friend_codes，RLS 限定 user_id = auth.uid()；
--      不进入 profiles 行，实时通道（realtime）不订阅该表 → 不会经推送泄露。
--   5) 仅通过 SECURITY DEFINER 函数读取/使用：get_my_codes 只返回本人，
--      add_friend_by_code 按码解析出对方，但绝不回传码本身。
-- ============================================================================

-- 1) 好友码表（每用户至多一条 perm + 一条 temp；code 全局唯一）
create table if not exists public.friend_codes (
  user_id    uuid    not null references public.profiles(id) on delete cascade,
  kind       text    not null check (kind in ('perm','temp')),
  code       text    not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind),
  unique (code)   -- 永久与临时之间也禁止重复
);

-- 2) RLS：仅本人可读写自己的好友码
alter table public.friend_codes enable row level security;
drop policy if exists "own codes select" on public.friend_codes;
create policy "own codes select" on public.friend_codes
  for select using (user_id = auth.uid());
drop policy if exists "own codes write" on public.friend_codes;
create policy "own codes write" on public.friend_codes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 3) profiles 增加「是否使用临时好友码」开关（非敏感，不含码本身）
alter table public.profiles add column if not exists use_temp_code boolean not null default false;

-- 4) 生成 8 位（数字 + 小写字母）全局唯一好友码
create or replace function public.gen_friend_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  chars text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  cand  text := '';
  i     int;
begin
  loop
    cand := '';
    for i in 1..8 loop
      cand := cand || substr(chars, floor(random() * 36)::int + 1, 1);
    end loop;
    if not exists (select 1 from public.friend_codes where code = cand) then
      return cand;
    end if;
  end loop;
end;
$$;
grant execute on function public.gen_friend_code() to authenticated;

-- 5) 本人查看自己的好友码
create or replace function public.get_my_codes()
returns table(perm_code text, use_temp boolean, temp_code text)
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  return query
    select
      (select code from public.friend_codes where user_id = v_uid and kind = 'perm') as perm_code,
      (select use_temp_code from public.profiles where id = v_uid) as use_temp,
      (select code from public.friend_codes where user_id = v_uid and kind = 'temp') as temp_code;
end;
$$;
grant execute on function public.get_my_codes() to authenticated;

-- 6) 切换永久 / 临时；启用临时时若无临时码则生成一个，关闭时清除临时码
create or replace function public.set_use_temp_code(p_val boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  update public.profiles set use_temp_code = p_val where id = v_uid;
  if p_val then
    if not exists (select 1 from public.friend_codes where user_id = v_uid and kind = 'temp') then
      insert into public.friend_codes(user_id, kind, code)
      values (v_uid, 'temp', public.gen_friend_code());
    end if;
  else
    delete from public.friend_codes where user_id = v_uid and kind = 'temp';
  end if;
end;
$$;
grant execute on function public.set_use_temp_code(boolean) to authenticated;

-- 7) 手动换一个临时好友码（仅在启用临时码时可用）
create or replace function public.regen_temp_code()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  if not (select use_temp_code from public.profiles where id = v_uid) then
    raise exception 'TEMP_DISABLED';
  end if;
  delete from public.friend_codes where user_id = v_uid and kind = 'temp';
  insert into public.friend_codes(user_id, kind, code)
  values (v_uid, 'temp', public.gen_friend_code());
end;
$$;
grant execute on function public.regen_temp_code() to authenticated;

-- 8) 通过好友码添加好友：解析对方 → 建立好友申请 → 若是临时码则消耗并自动换新
--    返回对方信息（绝不回传码本身），outcome 取值：
--      requested      成功发起（或被拒绝后重新发起）
--      already_pending 你此前已向对方发起申请
--      they_pending    对方已向你发起申请
create or replace function public.add_friend_by_code(p_code text, p_note text)
returns table(target_id uuid, target_nickname text, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_target uuid;
  v_kind  text;
  v_nick  text;
  v_rel   record;
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  if p_code is null or trim(p_code) = '' then raise exception 'CODE_EMPTY'; end if;

  select user_id, kind into v_target, v_kind
  from public.friend_codes where code = trim(p_code);
  if v_target is null then raise exception 'CODE_NOT_FOUND'; end if;
  if v_target = v_uid then raise exception 'CANNOT_ADD_SELF'; end if;

  select nickname into v_nick from public.profiles where id = v_target;

  -- 已有关系？
  select id, status, requester_id into v_rel
  from public.friendships
  where (requester_id = v_uid and addressee_id = v_target)
     or (requester_id = v_target and addressee_id = v_uid)
  limit 1;

  if found then
    if v_rel.status = 'accepted' then
      raise exception 'ALREADY_FRIEND';
    elsif v_rel.status = 'pending' then
      if v_rel.requester_id = v_uid then
        return query select v_target, v_nick, 'already_pending'::text;
      else
        return query select v_target, v_nick, 'they_pending'::text;
      end if;
      return;
    else
      -- 此前被拒绝：重新发起
      update public.friendships
         set status = 'pending', request_note = v_note, updated_at = now()
       where id = v_rel.id;
    end if;
  else
    insert into public.friendships(requester_id, addressee_id, status, request_note)
    values (v_uid, v_target, 'pending', v_note);
  end if;

  -- 消耗临时码（若是），并按需自动生成下一个
  if v_kind = 'temp' then
    delete from public.friend_codes where user_id = v_target and kind = 'temp';
    if (select use_temp_code from public.profiles where id = v_target) then
      insert into public.friend_codes(user_id, kind, code)
      values (v_target, 'temp', public.gen_friend_code());
    end if;
  end if;

  return query select v_target, v_nick, 'requested'::text;
end;
$$;
grant execute on function public.add_friend_by_code(text, text) to authenticated;

-- 9) 回填：为尚无永久码的用户补一个（幂等）
insert into public.friend_codes(user_id, kind, code)
select p.id, 'perm', public.gen_friend_code()
from public.profiles p
where not exists (
  select 1 from public.friend_codes fc where fc.user_id = p.id and fc.kind = 'perm'
);

-- 10) 新用户注册时分配永久好友码（重写 handle_new_user，保留原 user_number 逻辑）
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

  -- 分配永久好友码（每用户一个，全局唯一）
  insert into public.friend_codes (user_id, kind, code)
  values (new.id, 'perm', public.gen_friend_code())
  on conflict (user_id, kind) do nothing;

  return new;
end;
$$;

notify pgrst, 'reload schema';

select '好友码功能已就绪：永久码注册即分配，临时码可切换/换码，添加走 add_friend_by_code' as status;
