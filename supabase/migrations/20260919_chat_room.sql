-- ============================================================================
--  v301：在线聊天室
--   公共聊天室：进入后可对所有「在线且处于聊天室内」的用户发言、加好友
--   在线人数：45 秒内有心跳即算在线（chatroom_presence.last_seen）
--   详情页 / 加好友复用既有 profile-modal（称号）与好友申请弹窗
--  幂等可重跑。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 聊天室消息
-- ---------------------------------------------------------------------------
create table if not exists public.chatroom_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  content    text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists chatroom_messages_created_idx
  on public.chatroom_messages (created_at desc);

alter table public.chatroom_messages enable row level security;
drop policy if exists "chatroom_messages_select" on public.chatroom_messages;
create policy "chatroom_messages_select" on public.chatroom_messages
  for select to authenticated using (deleted_at is null);

-- ---------------------------------------------------------------------------
-- 2. 在场状态（进入聊天室后心跳维持）
-- ---------------------------------------------------------------------------
create table if not exists public.chatroom_presence (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  last_seen timestamptz not null default now()
);
create index if not exists chatroom_presence_seen_idx on public.chatroom_presence (last_seen);

alter table public.chatroom_presence enable row level security;
drop policy if exists "chatroom_presence_select" on public.chatroom_presence;
create policy "chatroom_presence_select" on public.chatroom_presence
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. RPC
-- ---------------------------------------------------------------------------
-- 心跳：进入聊天室 / 每 15s 调一次，退出时调 chatroom_leave
create or replace function public.chatroom_heartbeat()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.chatroom_presence(user_id, last_seen)
  values (auth.uid(), now())
  on conflict (user_id) do update set last_seen = now();
$$;
grant execute on function public.chatroom_heartbeat() to authenticated;

create or replace function public.chatroom_leave()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.chatroom_presence where user_id = auth.uid();
$$;
grant execute on function public.chatroom_leave() to authenticated;

-- 在线成员（45s 内有心跳）+ 人数
create or replace function public.chatroom_online()
returns table (
  user_id uuid, nickname text, avatar_path text, user_number bigint, last_seen timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.nickname, p.avatar_path, p.user_number, cp.last_seen
    from public.chatroom_presence cp
    join public.profiles p on p.id = cp.user_id
   where cp.last_seen > now() - interval '45 seconds'
   order by cp.last_seen desc
   limit 200;
$$;
grant execute on function public.chatroom_online() to authenticated;

-- 最近消息（含作者资料，供前端渲染）
create or replace function public.chatroom_list(p_limit int)
returns table (
  id uuid, user_id uuid, content text, created_at timestamptz,
  nickname text, avatar_path text, user_number bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.user_id, m.content, m.created_at,
         p.nickname, p.avatar_path, p.user_number
    from public.chatroom_messages m
    join public.profiles p on p.id = m.user_id
   where m.deleted_at is null
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 60), 1), 200);
$$;
grant execute on function public.chatroom_list(int) to authenticated;

-- 发言
create or replace function public.chatroom_send(p_content text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_txt text := trim(coalesce(p_content, ''));
  v_id  uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  if v_txt = '' then raise exception 'CHATROOM_EMPTY'; end if;
  if char_length(v_txt) > 500 then raise exception 'CHATROOM_TOO_LONG'; end if;
  insert into public.chatroom_messages(user_id, content) values (v_uid, v_txt)
    returning id into v_id;
  -- 发言即视为在场
  insert into public.chatroom_presence(user_id, last_seen) values (v_uid, now())
    on conflict (user_id) do update set last_seen = now();
  return v_id;
end;
$$;
grant execute on function public.chatroom_send(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Realtime：让前端能订阅新消息
-- ---------------------------------------------------------------------------
alter table public.chatroom_messages replica identity full;
do $$
begin
  begin
    alter publication supabase_realtime add table public.chatroom_messages;
  exception when duplicate_object then null;
  end;
end $$;

notify pgrst, 'reload schema';
