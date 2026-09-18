-- ============================================================================
--  v297：交友广场帖子点赞 / 收藏
--   1) 每帖点赞、收藏各一份（forum_likes / forum_favorites，同一人同一帖只记一次）
--   2) 一键切换（已点赞再点即取消），返回最新状态与最新计数
--   3) 个人中心可查看「我点赞过的」「我收藏过的」帖子列表
--  幂等可重跑。依赖 20260914_forum.sql 的 forum_posts / forum_replies。
-- ============================================================================

create table if not exists public.forum_likes (
  post_id    uuid not null references public.forum_posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.forum_favorites (
  post_id    uuid not null references public.forum_posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists idx_forum_likes_user     on public.forum_likes (user_id, created_at desc);
create index if not exists idx_forum_favorites_user on public.forum_favorites (user_id, created_at desc);

alter table public.forum_likes     enable row level security;
alter table public.forum_favorites enable row level security;

-- 谁点的赞 / 收藏所有人都看得到（用于计数与「我是否点过」）
drop policy if exists "forum_likes_select" on public.forum_likes;
create policy "forum_likes_select" on public.forum_likes
  for select to authenticated using (true);
drop policy if exists "forum_likes_insert" on public.forum_likes;
create policy "forum_likes_insert" on public.forum_likes
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "forum_likes_delete" on public.forum_likes;
create policy "forum_likes_delete" on public.forum_likes
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "forum_favorites_select" on public.forum_favorites;
create policy "forum_favorites_select" on public.forum_favorites
  for select to authenticated using (true);
drop policy if exists "forum_favorites_insert" on public.forum_favorites;
create policy "forum_favorites_insert" on public.forum_favorites
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "forum_favorites_delete" on public.forum_favorites;
create policy "forum_favorites_delete" on public.forum_favorites
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 点赞 / 收藏切换：返回切换后的状态（true = 已点赞 / 已收藏）
-- ---------------------------------------------------------------------------
create or replace function public.forum_toggle_like(p_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_on boolean;
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  if not exists (select 1 from public.forum_posts p where p.id = p_post_id and p.deleted_by is null) then
    raise exception 'POST_NOT_FOUND';
  end if;
  if exists (select 1 from public.forum_likes l where l.post_id = p_post_id and l.user_id = v_uid) then
    delete from public.forum_likes where post_id = p_post_id and user_id = v_uid;
    v_on := false;
  else
    insert into public.forum_likes(post_id, user_id) values (p_post_id, v_uid)
      on conflict (post_id, user_id) do nothing;
    v_on := true;
  end if;
  return v_on;
end;
$$;
grant execute on function public.forum_toggle_like(uuid) to authenticated;

create or replace function public.forum_toggle_favorite(p_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_on boolean;
begin
  if v_uid is null then raise exception 'NOT_AUTH'; end if;
  if not exists (select 1 from public.forum_posts p where p.id = p_post_id and p.deleted_by is null) then
    raise exception 'POST_NOT_FOUND';
  end if;
  if exists (select 1 from public.forum_favorites f where f.post_id = p_post_id and f.user_id = v_uid) then
    delete from public.forum_favorites where post_id = p_post_id and user_id = v_uid;
    v_on := false;
  else
    insert into public.forum_favorites(post_id, user_id) values (p_post_id, v_uid)
      on conflict (post_id, user_id) do nothing;
    v_on := true;
  end if;
  return v_on;
end;
$$;
grant execute on function public.forum_toggle_favorite(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 批量取统计：点赞数 / 收藏数 / 我是否点过 / 我是否收藏（列表页一次拿全）
-- ---------------------------------------------------------------------------
create or replace function public.forum_post_stats(p_post_ids uuid[])
returns table (
  post_id uuid, like_count int, fav_count int,
  liked boolean, favorited boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         (select count(*) from public.forum_likes l     where l.post_id = p.id)::int,
         (select count(*) from public.forum_favorites f where f.post_id = p.id)::int,
         exists (select 1 from public.forum_likes l     where l.post_id = p.id and l.user_id = auth.uid()),
         exists (select 1 from public.forum_favorites f where f.post_id = p.id and f.user_id = auth.uid())
  from unnest(coalesce(p_post_ids, '{}'::uuid[])) as p(id);
$$;
grant execute on function public.forum_post_stats(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 个人中心：我点赞过 / 我收藏过的帖子（p_kind = 'like' | 'fav'）
-- ---------------------------------------------------------------------------
create or replace function public.forum_list_my_reacts(p_kind text, p_limit int default 50)
returns table (
  post_id uuid, title text, body text, created_at timestamptz,
  author_id uuid, author_nickname text, author_phone text, author_avatar text,
  like_count int, fav_count int, reply_count int, reacted_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select r.post_id, r.created_at as reacted_at
      from public.forum_likes r
     where r.user_id = auth.uid() and lower(coalesce(p_kind, 'like')) = 'like'
    union all
    select r.post_id, r.created_at
      from public.forum_favorites r
     where r.user_id = auth.uid() and lower(coalesce(p_kind, 'like')) = 'fav'
  )
  select p.id, p.title, p.body, p.created_at,
         p.author_id,
         au.nickname, au.phone, au.avatar_path,
         (select count(*) from public.forum_likes l     where l.post_id = p.id)::int,
         (select count(*) from public.forum_favorites f where f.post_id = p.id)::int,
         (select count(*) from public.forum_replies rp  where rp.post_id = p.id and rp.deleted_by is null)::int,
         m.reacted_at
  from mine m
  join public.forum_posts p on p.id = m.post_id
  left join public.profiles au on au.id = p.author_id
  where p.deleted_by is null
  order by m.reacted_at desc
  limit greatest(coalesce(p_limit, 50), 1);
$$;
grant execute on function public.forum_list_my_reacts(text, int) to authenticated;

-- 计数徽章：我点赞 / 收藏各多少条（个人中心入口显示用）
create or replace function public.forum_my_react_counts()
returns table (liked_count int, fav_count int)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.forum_likes l
       join public.forum_posts p on p.id = l.post_id
      where l.user_id = auth.uid() and p.deleted_by is null)::int,
    (select count(*) from public.forum_favorites f
       join public.forum_posts p on p.id = f.post_id
      where f.user_id = auth.uid() and p.deleted_by is null)::int;
$$;
grant execute on function public.forum_my_react_counts() to authenticated;

notify pgrst, 'reload schema';
