-- ============================================================================
--  v298：交友广场「新消息」红点（无数字）
--   有新帖子（他人发的） 或 自己的帖子被他人点赞 → 入口显示红点
--   进入广场即清除「新帖子」红点；查看「我的点赞」列表即清除「被赞」红点
--  幂等可重跑。依赖 20260914_forum.sql / 20260918_forum_like_fav.sql。
-- ============================================================================

-- 每人一行：记录「看到哪儿了」
create table if not exists public.forum_marks (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  posts_seen_at timestamptz not null default now(),
  likes_seen_at timestamptz not null default now()
);
alter table public.forum_marks enable row level security;

drop policy if exists "forum_marks_select" on public.forum_marks;
create policy "forum_marks_select" on public.forum_marks
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "forum_marks_insert" on public.forum_marks;
create policy "forum_marks_insert" on public.forum_marks
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "forum_marks_update" on public.forum_marks;
create policy "forum_marks_update" on public.forum_marks
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 是否有未读（新帖子 / 我的帖子被点赞）
-- ---------------------------------------------------------------------------
create or replace function public.forum_has_unread()
returns table (new_posts boolean, new_likes boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_p   timestamptz;
  v_l   timestamptz;
begin
  if v_uid is null then
    return query select false, false;
    return;
  end if;

  select m.posts_seen_at, m.likes_seen_at into v_p, v_l
    from public.forum_marks m
   where m.user_id = v_uid;

  -- 首次访问：以当前时间为基线，避免把历史帖子 / 历史点赞全算成新消息
  if v_p is null then
    insert into public.forum_marks(user_id) values (v_uid)
      on conflict (user_id) do nothing;
    v_p := now();
    v_l := now();
  end if;

  return query
  select
    exists (
      select 1 from public.forum_posts p
       where p.deleted_by is null
         and p.author_id <> v_uid
         and p.created_at > v_p
    ),
    exists (
      select 1
        from public.forum_likes l
        join public.forum_posts p on p.id = l.post_id
       where p.author_id = v_uid
         and l.user_id <> v_uid
         and p.deleted_by is null
         and l.created_at > coalesce(v_l, v_p)
    );
end;
$$;
grant execute on function public.forum_has_unread() to authenticated;

-- ---------------------------------------------------------------------------
-- 标记已读：p_kind = 'posts' | 'likes' | 'all'
-- ---------------------------------------------------------------------------
create or replace function public.forum_mark_seen(p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  insert into public.forum_marks(user_id) values (v_uid)
    on conflict (user_id) do nothing;

  if lower(coalesce(p_kind, 'all')) = 'posts' then
    update public.forum_marks set posts_seen_at = now() where user_id = v_uid;
  elsif lower(coalesce(p_kind, 'all')) = 'likes' then
    update public.forum_marks set likes_seen_at = now() where user_id = v_uid;
  else
    update public.forum_marks
       set posts_seen_at = now(), likes_seen_at = now()
     where user_id = v_uid;
  end if;
end;
$$;
grant execute on function public.forum_mark_seen(text) to authenticated;

notify pgrst, 'reload schema';
