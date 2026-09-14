-- ============================================================
-- 轻聊 chatapp · 待执行迁移整合包（生成于 2026-09-14）
-- 用法：Supabase 控制台 → SQL Editor → New query → 全文粘贴 → Run
-- 说明：全部语句幂等（create or replace / if not exists / drop policy if exists），
--       已执行过的部分重复执行不会报错，可放心整段重跑。
-- 包含：v275 / v276 / v280 / v281 / v286 共 5 项迁移
--  1) 20260914_gm_friend_code.sql   —— GM 查看用户永久好友码
--  2) 20260914_group_admin.sql      —— 群管理员（含 GM 设/撤管理员）
--  3) 20260914_forum.sql            —— 交友广场（帖子/媒体/回复/关注）
--  4) 20260914_dev_search_phone.sql —— 开发者按手机号搜隐藏手机号用户
--  5) 20260914_group_media_read.sql —— 群聊图片/视频其他成员可读取
-- ============================================================


-- ----------------------------------------------------------------------
-- ▼ 来源：supabase/migrations/20260914_gm_friend_code.sql   （v275 GM 查看用户永久好友码）
-- ----------------------------------------------------------------------
-- ============================================================
--  GM 后台查看用户永久好友码（v275）
--  用法：Supabase 控制台 → SQL Editor → 全文粘贴 → Run。可重复执行（幂等）。
--  设计要点：
--   1) friend_codes 表 RLS 仅本人可读（user_id = auth.uid()），GM 无法直接查。
--   2) 新增 SECURITY DEFINER 函数 gm_get_user_friend_code，GM 凭口令读取
--      指定用户的永久好友码（kind='perm'），不回传临时码。
--   3) 与现有 gm_search_users 一致，先用 gm_check 校验 GM 口令。
-- ============================================================

drop function if exists public.gm_get_user_friend_code(text, uuid) cascade;
create or replace function public.gm_get_user_friend_code(p_pwd text, p_user_id uuid)
returns table (perm_code text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
    select fc.code
    from public.friend_codes fc
    where fc.user_id = p_user_id
      and fc.kind = 'perm';
end;
$$;
grant execute on function public.gm_get_user_friend_code(text, uuid) to authenticated;


select 'GM 查看用户永久好友码已就绪：gm_get_user_friend_code' as status;


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


-- ----------------------------------------------------------------------
-- ▼ 来源：supabase/migrations/20260914_dev_search_phone.sql   （v281 开发者可按手机号搜隐藏手机号用户）
-- ----------------------------------------------------------------------
-- ============================================================
-- v281: 开发者通过手机号搜索隐藏手机号的用户
-- 用法：Supabase 控制台 → SQL Editor → 全文粘贴 → Run。可重复执行（幂等）。
-- 设计要点：
--   1) 普通用户在「添加好友」里按手机号搜索时，仍走直接查询 + hide_phone=false 过滤，
--      确保隐私开关生效。
--   2) 开发者（持有「开发者」称号）调用此 SECURITY DEFINER RPC，绕过 RLS
--      按精确手机号查找用户，可命中 hide_phone=true 的记录。
--   3) 权限校验复用已有的 public.is_dev_user()，非开发者调用直接抛 DEV_FORBIDDEN。
-- ============================================================

drop function if exists public.search_user_by_phone_for_dev(text) cascade;

create or replace function public.search_user_by_phone_for_dev(p_phone text)
returns table (
  id          uuid,
  phone       text,
  nickname    text,
  avatar_path text,
  hide_phone  boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_dev_user() then
    raise exception 'DEV_FORBIDDEN';
  end if;

  return query
    select p.id, p.phone, p.nickname, p.avatar_path, p.hide_phone
    from public.profiles p
    where p.phone = p_phone;
end;
$$;

grant execute on function public.search_user_by_phone_for_dev(text) to authenticated;


-- ----------------------------------------------------------------------
-- ▼ 来源：supabase/migrations/20260914_group_media_read.sql   （v286 修复群聊图片/视频其他成员读不到）
-- ----------------------------------------------------------------------
-- ============================================================
-- v286：修复「群聊里的图片 / 视频别人看不到」——存储读策略遗漏群成员
-- ============================================================
-- 现象：私聊发的图片、视频正常；同样的图发到群里，除发送者本人外，
--       其它群成员都加载不出来（图片空白 / 视频打不开）。
-- 根因：chat_files_read 策略原来只放行
--         (1) 文件在自己 uid 目录下（发送者本人）
--         (2) 存在 messages 记录 m.file_path = 该对象，
--             且 m.sender_id = 我 或 m.receiver_id = 我
--       而群聊消息 receiver_id 为 NULL（只有 group_id），
--       → 群成员（非发送者）全部命中不了 read 策略，签名 URL 生成失败。
-- 修复：在 exists 子查询里补上「该消息属于我所在群」的分支。
-- ============================================================

drop policy if exists "chat_files_read" on storage.objects;
create policy "chat_files_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-files'
    and (
      public.is_admin_user()                                  -- 管理员可读桶内任意对象（查看举报图片/视频）
      or (storage.foldername(name))[1] = auth.uid()::text     -- 自己目录下的文件
      or exists (
        select 1 from public.messages m
        where m.file_path = storage.objects.name
          and (
            m.sender_id = auth.uid()                          -- 我发的
            or m.receiver_id = auth.uid()                     -- 1v1 发给我的
            or (                                              -- 群消息：我是该群成员即可读
              m.group_id is not null
              and public.is_group_member(auth.uid(), m.group_id)
            )
          )
      )
    )
  );

-- 通知 PostgREST / Storage 重新加载 schema，使新策略立即生效

-- --------------------------------------------------------------------
-- 结束：通知 PostgREST / Storage 重新加载 schema，使新建的表与策略立即可用
-- --------------------------------------------------------------------
notify pgrst, 'reload schema';
