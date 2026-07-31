-- ============================================================
--  聊天网页 · Supabase 初始化脚本
--  用法：Supabase 控制台 → SQL Editor → New query → 全文粘贴 → Run
--  可重复执行（幂等）
-- ============================================================

-- ------------------------------------------------------------
-- 1. 用户资料表（手机号即账号）
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  phone        text unique not null,
  nickname     text not null,
  avatar_color text not null default '#4f7cf7',
  created_at   timestamptz not null default now()
);

create index if not exists profiles_phone_idx on public.profiles (phone);

-- ------------------------------------------------------------
-- 2. 好友关系表（一行代表一段关系，含待处理的好友申请）
-- ------------------------------------------------------------
create table if not exists public.friendships (
  id           bigserial primary key,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'rejected')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);

-- ------------------------------------------------------------
-- 3. 消息表
-- ------------------------------------------------------------
create table if not exists public.messages (
  id          bigserial primary key,
  sender_id   uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'text'
              check (kind in ('text', 'image', 'video', 'file')),
  content     text,
  file_path   text,
  file_name   text,
  file_size   bigint,
  created_at  timestamptz not null default now(),
  recalled    boolean not null default false
);

-- 已部署过的旧库不会因上面的建表语句自动加列，这里用 ALTER 补齐（幂等）
alter table public.messages
  add column if not exists recalled boolean not null default false;

create index if not exists messages_pair_idx
  on public.messages (sender_id, receiver_id, created_at desc);
create index if not exists messages_receiver_idx
  on public.messages (receiver_id, created_at desc);

-- ------------------------------------------------------------
-- 4. 判断两人是否已是好友（供 RLS 策略调用）
-- ------------------------------------------------------------
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and ( (f.requester_id = a and f.addressee_id = b)
         or (f.requester_id = b and f.addressee_id = a) )
  );
$$;

-- ------------------------------------------------------------
-- 5. 注册后自动创建资料（读取注册时提交的 phone / nickname）
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone, nickname)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'phone', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'nickname', '用户' || substr(new.id::text, 1, 4))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 6. 行级安全策略（RLS）—— 数据隔离的核心，务必开启
-- ------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.friendships enable row level security;
alter table public.messages    enable row level security;

-- profiles：登录用户可查（否则无法按手机号搜人），但只能改自己的
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (auth.uid() = id);

-- friendships：只能看到与自己有关的关系
drop policy if exists "friendships_select" on public.friendships;
create policy "friendships_select" on public.friendships
  for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop policy if exists "friendships_insert" on public.friendships;
create policy "friendships_insert" on public.friendships
  for insert to authenticated
  with check (auth.uid() = requester_id);

-- 只有被申请方能同意/拒绝
drop policy if exists "friendships_update" on public.friendships;
create policy "friendships_update" on public.friendships
  for update to authenticated
  using (auth.uid() = addressee_id);

drop policy if exists "friendships_delete" on public.friendships;
create policy "friendships_delete" on public.friendships
  for delete to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- messages：只能读自己收发的；只能以自己名义发，且必须是好友
drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages
  for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert to authenticated
  with check (
    auth.uid() = sender_id
    and public.are_friends(sender_id, receiver_id)
  );

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own" on public.messages
  for delete to authenticated
  using (auth.uid() = sender_id);

-- 撤回功能：只允许更新自己发出的消息（软删除：置 recalled=true 并清空内容）
drop policy if exists "messages_update_own" on public.messages;
create policy "messages_update_own" on public.messages
  for update to authenticated
  using (auth.uid() = sender_id)
  with check (auth.uid() = sender_id);

-- ------------------------------------------------------------
-- 7. 开启实时推送（新消息、好友申请即时到达）
-- ------------------------------------------------------------
alter table public.messages    replica identity full;
alter table public.friendships replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.friendships;
  exception when duplicate_object then null;
  end;
end $$;

-- ------------------------------------------------------------
-- 8. 文件存储桶（私有，通过临时签名链接访问）
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('chat-files', 'chat-files', false)
on conflict (id) do nothing;

-- 只能上传到以自己 uid 命名的目录下
drop policy if exists "chat_files_upload" on storage.objects;
create policy "chat_files_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 自己上传的文件、或出现在自己会话消息里的文件，才可读取
drop policy if exists "chat_files_read" on storage.objects;
create policy "chat_files_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-files'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.messages m
        where m.file_path = storage.objects.name
          and (m.sender_id = auth.uid() or m.receiver_id = auth.uid())
      )
    )
  );

drop policy if exists "chat_files_delete_own" on storage.objects;
create policy "chat_files_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
