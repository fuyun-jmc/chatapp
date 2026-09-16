-- ----------------------------------------------------------------------
-- ▼ 来源：supabase/migrations/20260914_forum.sql   （v280 交友广场（帖子/媒体/回复/关注））
-- ----------------------------------------------------------------------
-- ============================================================
-- 交友广场（v280）：帖子 / 媒体 / 嵌套回复 / 关注
-- 存储复用已有 chat-files 桶，媒体放在 <uid>/square/* 下，
-- 命中既有 chat_files_upload（仅自己 uid 目录可上传）策略。
-- ============================================================

-- 帖子
create table if not exists public.forum_posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  body        text not null default '',
  link        text default null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_by  uuid[] default null          -- 软删除：作者删除后置 [author_id]
);

-- 帖子媒体（图片 / 视频），path 为 chat-files 桶内路径
create table if not exists public.forum_post_media (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.forum_posts(id) on delete cascade,
  url         text not null,
  media_type  text not null check (media_type in ('image','video')),
  sort_order  int not null default 0
);

-- 回复（parent_id 为空=对帖子的顶层回复；非空=对某条回复的回复）
create table if not exists public.forum_replies (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.forum_posts(id) on delete cascade,
  author_id   uuid not null references auth.users(id) on delete cascade,
  parent_id   uuid references public.forum_replies(id) on delete cascade,
  body        text not null default '',
  created_at  timestamptz not null default now(),
  deleted_by  uuid[] default null
);

-- 关注关系
create table if not exists public.user_follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id)
);

-- 索引
create index if not exists idx_forum_posts_created on public.forum_posts (created_at desc);
create index if not exists idx_forum_posts_author   on public.forum_posts (author_id);
create index if not exists idx_forum_post_media_post on public.forum_post_media (post_id, sort_order);
create index if not exists idx_forum_replies_post    on public.forum_replies (post_id, created_at);
create index if not exists idx_forum_replies_parent  on public.forum_replies (parent_id);
create index if not exists idx_user_follows_followee on public.user_follows (followee_id);
create index if not exists idx_user_follows_follower on public.user_follows (follower_id);

-- 行级安全
alter table public.forum_posts      enable row level security;
alter table public.forum_post_media enable row level security;
alter table public.forum_replies    enable row level security;
alter table public.user_follows     enable row level security;

-- 帖子：所有人可读未删除的；仅作者可写
drop policy if exists "forum_posts_select" on public.forum_posts;
create policy "forum_posts_select" on public.forum_posts
  for select to authenticated using (deleted_by is null);
drop policy if exists "forum_posts_insert" on public.forum_posts;
create policy "forum_posts_insert" on public.forum_posts
  for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "forum_posts_update" on public.forum_posts;
create policy "forum_posts_update" on public.forum_posts
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists "forum_posts_delete" on public.forum_posts;
create policy "forum_posts_delete" on public.forum_posts
  for delete to authenticated using (author_id = auth.uid());

-- 媒体：所有人可读；仅帖子作者可增删
drop policy if exists "forum_media_select" on public.forum_post_media;
create policy "forum_media_select" on public.forum_post_media
  for select to authenticated using (true);
drop policy if exists "forum_media_insert" on public.forum_post_media;
create policy "forum_media_insert" on public.forum_post_media
  for insert to authenticated with check (
    exists (select 1 from public.forum_posts p where p.id = post_id and p.author_id = auth.uid())
  );
drop policy if exists "forum_media_delete" on public.forum_post_media;
create policy "forum_media_delete" on public.forum_post_media
  for delete to authenticated using (
    exists (select 1 from public.forum_posts p where p.id = post_id and p.author_id = auth.uid())
  );

-- 回复：所有人可读未删除的；仅作者可写（含软删除）
drop policy if exists "forum_replies_select" on public.forum_replies;
create policy "forum_replies_select" on public.forum_replies
  for select to authenticated using (deleted_by is null);
drop policy if exists "forum_replies_insert" on public.forum_replies;
create policy "forum_replies_insert" on public.forum_replies
  for insert to authenticated with check (author_id = auth.uid());
drop policy if exists "forum_replies_update" on public.forum_replies;
create policy "forum_replies_update" on public.forum_replies
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
drop policy if exists "forum_replies_delete" on public.forum_replies;
create policy "forum_replies_delete" on public.forum_replies
  for delete to authenticated using (author_id = auth.uid());

-- 关注：所有人可读；仅本人可关注 / 取关
drop policy if exists "user_follows_select" on public.user_follows;
create policy "user_follows_select" on public.user_follows
  for select to authenticated using (true);
drop policy if exists "user_follows_insert" on public.user_follows;
create policy "user_follows_insert" on public.user_follows
  for insert to authenticated with check (follower_id = auth.uid());
drop policy if exists "user_follows_delete" on public.user_follows;
create policy "user_follows_delete" on public.user_follows
  for delete to authenticated using (follower_id = auth.uid());

-- 存储：登录用户可读任何 <uid>/square/* 下的帖子媒体
drop policy if exists "chat_files_square_read" on storage.objects;
create policy "chat_files_square_read" on storage.objects
  for select to authenticated
  using ( bucket_id = 'chat-files' and (storage.foldername(name))[2] = 'square' );

-- 通知 PostgREST 重新加载 schema，使新建的 forum_* / user_follows 表立即可被 supabase-js 查询
