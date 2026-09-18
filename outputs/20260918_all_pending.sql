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


-- ============================================================
--  v289：次级开发者称号
--  来源：supabase/migrations/20260915_sub_developer_title.sql
-- ============================================================
-- ============================================================
-- 新增称号「次级开发者」（v289）：效果与「开发者」完全相同
--   同样的强制展示槽位（不占自选槽位）、同样的专属头像框与紫色徽标、
--   同样的权限（is_dev_user / is_admin_user 均视为开发者）、
--   同样可在个人设置里「隐藏称号」（隐藏不影响权限）。
--   与开发者一样：GM 后台不可授予，需由站长用 SQL 直接写入 user_titles。
-- 用法：Supabase 控制台 → SQL Editor → 全文粘贴 → Run（幂等，可重复执行）
-- ============================================================

-- 1) 建立称号（若已存在则跳过）
insert into public.titles (name, description, frame_color, frame_style, cond_type)
select '次级开发者',
       '与「开发者」同等权限：可查看任意违禁词明细、可按手机号搜索隐藏手机号用户，展示专属头像框',
       '#7c4dff', 'dev', 'manual'
where not exists (select 1 from public.titles where name = '次级开发者');


-- --------------------------------------------------------------------
-- 重建函数：public.touch_login_streak（开发者判定扩展为 开发者 / 次级开发者）
-- --------------------------------------------------------------------
create or replace function public.touch_login_streak()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_last   date;
  v_streak int;
  v_total  int;
  v_warncnt int;
  v_reg    date;
  v_clean  int;
  v_equip  record;
begin
  if v_uid is null then return; end if;
  select last_login_date, login_streak, total_login_days, created_at
    into v_last, v_streak, v_total, v_reg
    from public.profiles where id = v_uid for update;

  -- 连续登录天数
  if v_last is null then
    v_streak := 1;
  elsif v_last = current_date then
    null;
  elsif v_last = current_date - 1 then
    v_streak := coalesce(v_streak, 0) + 1;
  else
    v_streak := 1;
  end if;

  -- 累计登录天数（按自然日去重，仅“新的一天”才 +1）
  if v_last is null or v_last < current_date then
    v_total := coalesce(v_total, 0) + 1;
  else
    v_total := coalesce(v_total, 0);
  end if;

  -- 连续未触发违禁词警告天数：从注册起算；中途触发过任意一次则直接中断为 0
  select count(*) into v_warncnt
    from public.word_warnings where user_id = v_uid;
  if v_warncnt > 0 then
    v_clean := 0;
  else
    v_clean := greatest(0, current_date - date(v_reg));
  end if;

  update public.profiles
     set login_streak     = v_streak,
         total_login_days = v_total,
         last_login_date  = current_date,
         clean_streak     = v_clean
   where id = v_uid;

  -- 自动授予满足条件的称号（streak / total_login / clean_streak）
  insert into public.user_titles (user_id, title_id, source)
  select v_uid, t.id, 'auto'
  from public.titles t
  where t.cond_type in ('streak', 'total_login', 'clean_streak')
    and t.cond_value is not null
    and (
      (t.cond_type = 'streak'        and t.cond_value <= v_streak) or
      (t.cond_type = 'total_login'   and t.cond_value <= v_total)  or
      (t.cond_type = 'clean_streak'  and t.cond_value <= v_clean)
    )
    and not exists (
      select 1 from public.user_titles ut where ut.user_id = v_uid and ut.title_id = t.id
    );

  -- 自动装配：把已拥有但未装配的自选称号按获得顺序装到空位，装满 2 个为止
  for v_equip in
    select ut.title_id as tid
      from public.user_titles ut
      join public.titles t on t.id = ut.title_id
     where ut.user_id = v_uid
       and t.name not in ('管理员', '开发者', '次级开发者')
       and ut.title_id is distinct from (select display_title_id  from public.profiles p where p.id = v_uid)
       and ut.title_id is distinct from (select display_title_id2 from public.profiles p where p.id = v_uid)
     order by ut.granted_at asc
  loop
    perform public.auto_equip_free_slot(v_uid, v_equip.tid);
  end loop;
end;
$$;
grant execute on function public.touch_login_streak() to authenticated;

-- --------------------------------------------------------------------
-- 重建函数：public.auto_equip_free_slot（开发者判定扩展为 开发者 / 次级开发者）
-- --------------------------------------------------------------------
create or replace function public.auto_equip_free_slot(p_user_id uuid, p_title_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_d1 uuid;
  v_d2 uuid;
  v_equipped int;
begin
  if p_user_id is null or p_title_id is null then
    return;
  end if;
  -- 强制称号（管理员/开发者）独立展示，不占用自选槽位
  if exists (
    select 1 from public.titles
     where id = p_title_id and name in ('管理员', '开发者', '次级开发者')
  ) then
    return;
  end if;
  select display_title_id, display_title_id2
    into v_d1, v_d2
    from public.profiles where id = p_user_id;
  -- 已在该用户自选槽位中，不重复装配
  if v_d1 = p_title_id or v_d2 = p_title_id then
    return;
  end if;
  v_equipped := (case when v_d1 is not null then 1 else 0 end)
              + (case when v_d2 is not null then 1 else 0 end);
  -- 两个空位装满后，不再自动装配
  if v_equipped >= 2 then
    return;
  end if;
  if v_d1 is null then
    update public.profiles set display_title_id = p_title_id where id = p_user_id;
  else
    update public.profiles set display_title_id2 = p_title_id where id = p_user_id;
  end if;
end;
$$;
grant execute on function public.auto_equip_free_slot(uuid, uuid) to authenticated;

-- --------------------------------------------------------------------
-- 重建函数：public.set_my_titles（开发者判定扩展为 开发者 / 次级开发者）
-- --------------------------------------------------------------------
create or replace function public.set_my_titles(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- 去 null + 去重，保留首次出现的先后顺序
  select coalesce(array_agg(x order by ord), '{}'::uuid[])
    into v_ids
    from (
      select u.x, min(u.ord) as ord
        from unnest(coalesce(p_ids, '{}'::uuid[])) with ordinality as u(x, ord)
       where u.x is not null
       group by u.x
    ) s;

  if coalesce(array_length(v_ids, 1), 0) > 2 then
    raise exception 'SLOT_FULL';
  end if;

  foreach v_id in array coalesce(v_ids, '{}'::uuid[]) loop
    -- 只能佩戴自己拥有的称号
    if not exists (
      select 1 from public.user_titles
       where user_id = v_uid and title_id = v_id
    ) then
      raise exception 'NOT_OWNED';
    end if;
    -- 强制称号自动展示，不占用自选槽位
    if exists (
      select 1 from public.titles
       where id = v_id and name in ('管理员', '开发者', '次级开发者')
    ) then
      raise exception 'FORCED_TITLE';
    end if;
  end loop;

  update public.profiles
     set display_title_id  = v_ids[1],
         display_title_id2 = v_ids[2]
   where id = v_uid;
end;
$$;
grant execute on function public.set_my_titles(uuid[]) to authenticated;

-- --------------------------------------------------------------------
-- 重建函数：public.get_profiles_titles（开发者判定扩展为 开发者 / 次级开发者）
-- --------------------------------------------------------------------
create or replace function public.get_profiles_titles(p_ids uuid[])
returns table (
  user_id            uuid,
  title_id           uuid,
  title_name         text,
  frame_color        text,
  frame_style        text,
  title2_id          uuid,
  title2_name        text,
  title2_color       text,
  title2_frame       text,
  admin_title_id     uuid,
  admin_title_name   text,
  admin_title_color  text,
  admin_title_frame  text,
  dev_title_id       uuid,
  dev_title_name     text,
  dev_title_color    text,
  dev_title_frame    text
)
language sql
security definer
set search_path = public
as $$
  select
    p.id,
    p.display_title_id,
    t.name,
    t.frame_color,
    t.frame_style,
    p.display_title_id2,
    t2.name,
    t2.frame_color,
    t2.frame_style,
    a.aid,
    a.an,
    a.ac,
    a.af,
    d.did,
    d.dn,
    d.dc,
    d.df
  from public.profiles p
  left join public.titles t  on t.id  = p.display_title_id
  left join public.titles t2 on t2.id = p.display_title_id2
  -- 管理员：强制展示，无隐藏开关
  left join lateral (
    select at.id as aid, at.name as an, at.frame_color as ac, at.frame_style as af
      from public.user_titles aut
      join public.titles at on at.id = aut.title_id
     where aut.user_id = p.id and at.name = '管理员'
     limit 1
  ) a on true
  -- 开发者：hide_dev_title = true 时整槽位不返回
  left join lateral (
    select dt.id as did, dt.name as dn, dt.frame_color as dc, dt.frame_style as df
      from public.user_titles dut
      join public.titles dt on dt.id = dut.title_id
     where dut.user_id = p.id
       and dt.name in ('开发者', '次级开发者')
       and coalesce(p.hide_dev_title, false) = false
     limit 1
  ) d on true
  where p.id = any(p_ids);
$$;
grant execute on function public.get_profiles_titles(uuid[]) to authenticated;

-- --------------------------------------------------------------------
-- 重建函数：public.set_hide_dev_title（开发者判定扩展为 开发者 / 次级开发者）
-- --------------------------------------------------------------------
create or replace function public.set_hide_dev_title(p_hide boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_has boolean;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  select exists (
    select 1
      from public.user_titles ut
      join public.titles t on t.id = ut.title_id
     where ut.user_id = v_uid
       and t.name in ('开发者', '次级开发者')
  ) into v_has;
  if not v_has then
    raise exception 'NOT_DEV';
  end if;
  update public.profiles
     set hide_dev_title = coalesce(p_hide, false)
   where id = v_uid;
  return coalesce(p_hide, false);
end;
$$;
grant execute on function public.set_hide_dev_title(boolean) to authenticated;

-- --------------------------------------------------------------------
-- 重建函数：public.is_admin_user（开发者判定扩展为 开发者 / 次级开发者）
-- --------------------------------------------------------------------
create or replace function public.is_admin_user()
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
       and t.name in ('管理员', '开发者', '次级开发者')
  );
$$;
grant execute on function public.is_admin_user() to authenticated;

-- --------------------------------------------------------------------
-- 重建函数：public.is_dev_user（开发者判定扩展为 开发者 / 次级开发者）
-- --------------------------------------------------------------------
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
       and t.name in ('开发者', '次级开发者')
  );
$$;
grant execute on function public.is_dev_user() to authenticated;

-- --------------------------------------------------------------------
-- 结束：通知 PostgREST 重新加载 schema
-- --------------------------------------------------------------------
notify pgrst, 'reload schema';


-- ============================================================
--  v291-v293：次级开发者授予 + 管理后台
--  来源：supabase/migrations/20260916_subdev_gm.sql
-- ============================================================
-- ============================================================
--  v291：次级开发者可被开发者授予 + 次级开发者可进入「简易 GM 后台」
--  授权模型：
--    admin  = 站长（gm_admin_uid()）
--    dev    = 持有「开发者」称号
--    subdev = 持有「次级开发者」称号
--  简易后台开放给 dev / subdev（额外包含 admin），仅提供四项能力：
--    ① 查看全部用户在线状态  ② 注销用户账号
--    ③ 查看群聊状态          ④ 修改群聊群主 / 管理员
--  安全兜底：站长与「开发者」为受保护账号，subdev 不能注销他们、
--            也不能授予 / 撤销他们身上的次级开发者称号。
-- ============================================================

-- 1) 角色判定（不校验口令，纯查询当前登录者的后台身份）
create or replace function public.gm2_role()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_res text;
begin
  v_uid := auth.uid();
  if v_uid is null then return null; end if;
  if (v_uid::uuid) is not distinct from public.gm_admin_uid() then
    return 'admin';
  end if;
  select case
           when bool_or(t.name = '开发者')     then 'dev'
           when bool_or(t.name = '次级开发者') then 'subdev'
         end
    into v_res
    from public.user_titles ut
    join public.titles t on t.id = ut.title_id
   where ut.user_id = v_uid
     and t.name in ('开发者', '次级开发者');
  return v_res;   -- 没有任何开发者类称号时返回 null
end;
$$;
grant execute on function public.gm2_role() to authenticated;

-- 2) 统一鉴权：返回本次调用者的角色，无权/口令错直接抛异常
--    v291.1：口令可省略（p_pwd 为 null 或空串时不校验口令）。
--    简易后台对开发者 / 次级开发者免密码进入，身份由 Supabase 登录会话
--    （auth.uid()）保证，gm2_role() 已强制要求调用者的确持有对应称号。
create or replace function public.gm2_auth(p_pwd text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.gm2_role();
  if v_role is null then
    raise exception 'GM_FORBIDDEN';
  end if;
  if p_pwd is not null and p_pwd <> '' and p_pwd is distinct from public.gm_password() then
    raise exception 'GM_AUTH_FAIL';
  end if;
  return v_role;
end;
$$;
grant execute on function public.gm2_auth(text) to authenticated;

create or replace function public.gm2_check(p_pwd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_auth(p_pwd);
end;
$$;
grant execute on function public.gm2_check(text) to authenticated;

-- 3) 受保护账号：站长 + 所有「开发者」（subdev 不可动）
create or replace function public.gm2_protected(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select (p_user_id::uuid is not distinct from public.gm_admin_uid())
      or exists (
           select 1
             from public.user_titles ut
             join public.titles t on t.id = ut.title_id
            where ut.user_id = p_user_id
              and t.name = '开发者'
         );
$$;
grant execute on function public.gm2_protected(uuid) to authenticated;

-- 4) 开发者（及以上）授予 / 撤销「次级开发者」称号
create or replace function public.dev_grant_subdev(p_pwd text, p_user_id uuid, p_grant boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_tid  uuid;
begin
  v_role := public.gm2_auth(p_pwd);
  if v_role not in ('admin', 'dev') then
    raise exception 'DEV_ONLY';
  end if;
  if p_user_id is null then raise exception '缺少目标用户'; end if;
  if (p_user_id::uuid) is not distinct from (auth.uid()::uuid) then
    raise exception '不能对自己执行该操作';
  end if;
  if v_role <> 'admin' and public.gm2_protected(p_user_id) then
    raise exception '该账号受保护，仅站长可操作';
  end if;

  select id into v_tid from public.titles where name = '次级开发者' limit 1;
  if v_tid is null then
    raise exception '称号「次级开发者」不存在，请先执行 v289 迁移（20260915_sub_developer_title.sql）';
  end if;

  if coalesce(p_grant, true) then
    insert into public.user_titles (user_id, title_id, source, granted_by)
    values (p_user_id, v_tid, 'manual', auth.uid())
    on conflict (user_id, title_id) do nothing;
  else
    delete from public.user_titles
     where user_id = p_user_id and title_id = v_tid;
  end if;
end;
$$;
grant execute on function public.dev_grant_subdev(text, uuid, boolean) to authenticated;

-- 5) 用户列表（含在线状态 / 角色）
drop function if exists public.gm2_list_users(text, text) cascade;

create or replace function public.gm2_list_users(p_pwd text, p_query text)
returns table (
  id          uuid,
  phone       text,
  nickname    text,
  avatar_path text,
  last_active timestamptz,
  created_at  timestamptz,
  user_number bigint,
  roles       text,
  is_subdev   boolean,
  is_protected boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  return query
    select p.id,
           p.phone,
           p.nickname,
           p.avatar_path,
           p.last_active,
           p.created_at,
           p.user_number,
           (select string_agg(t.name, '、' order by t.name)
              from public.user_titles ut
              join public.titles t on t.id = ut.title_id
             where ut.user_id = p.id
               and t.name in ('开发者', '次级开发者', '管理员')),
           exists (select 1
                     from public.user_titles ut
                     join public.titles t on t.id = ut.title_id
                    where ut.user_id = p.id and t.name = '次级开发者'),
           public.gm2_protected(p.id)
      from public.profiles p
     where (p_query is null or p_query = ''
            or p.phone ilike '%' || p_query || '%'
            or p.nickname ilike '%' || p_query || '%'
            or (p.user_number is not null and p.user_number::text = p_query))
     order by p.user_number asc nulls last
     limit 200;
end;
$$;
grant execute on function public.gm2_list_users(text, text) to authenticated;

-- 6) 注销用户账号（受保护账号需站长权限）
create or replace function public.gm2_delete_account(p_pwd text, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
begin
  v_role := public.gm2_auth(p_pwd);
  if p_user_id is null then raise exception '缺少目标用户'; end if;
  if (p_user_id::uuid) is not distinct from (auth.uid()::uuid) then
    raise exception '不能注销当前登录账号';
  end if;
  if v_role <> 'admin' and public.gm2_protected(p_user_id) then
    raise exception '该账号受保护，仅站长可注销';
  end if;

  delete from public.user_titles        where user_id = p_user_id;
  delete from public.group_members      where user_id = p_user_id;
  delete from public.device_sessions    where user_id = p_user_id;
  delete from public.friendships        where requester_id = p_user_id or addressee_id = p_user_id;

  -- identities / mfa_factors 等表在部分实例上不存在，逐条容错删除
  begin
    delete from auth.identities    where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;
  begin
    delete from auth.mfa_factors   where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;
  begin
    delete from auth.refresh_tokens where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;
  begin
    delete from auth.sessions      where user_id::text = p_user_id::text;
  exception when undefined_table or undefined_column then null;
  end;

  delete from auth.users where id::text = p_user_id::text;
  delete from public.profiles where id = p_user_id;
end;
$$;
grant execute on function public.gm2_delete_account(text, uuid) to authenticated;

-- 7) 群聊列表（含成员数 / 群主 / 状态）
drop function if exists public.gm2_list_groups(text, text) cascade;

create or replace function public.gm2_list_groups(p_pwd text, p_query text)
returns table (
  group_id       uuid,
  name           text,
  owner_id       uuid,
  owner_nickname text,
  owner_online   boolean,
  member_count   bigint,
  admin_count    bigint,
  created_at     timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  return query
    select g.id,
           g.name,
           g.owner_id,
           op.nickname,
           (op.last_active is not null and op.last_active > now() - interval '2 minutes'),
           (select count(*) from public.group_members m where m.group_id = g.id),
           (select count(*) from public.group_members m where m.group_id = g.id and m.is_admin),
           g.created_at
      from public.groups g
      left join public.profiles op on op.id = g.owner_id
     where (p_query is null or p_query = ''
            or g.name ilike '%' || p_query || '%'
            or op.nickname ilike '%' || p_query || '%')
     order by g.created_at desc
     limit 200;
end;
$$;
grant execute on function public.gm2_list_groups(text, text) to authenticated;

-- 8) 群成员列表（含在线 / 管理员状态）
drop function if exists public.gm2_list_group_members(text, uuid) cascade;

create or replace function public.gm2_list_group_members(p_pwd text, p_group_id uuid)
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
  perform public.gm2_check(p_pwd);
  return query
    select p.id,
           p.nickname,
           p.phone,
           p.avatar_path,
           p.last_active,
           (g.owner_id = p.id),
           coalesce(m.is_admin, false)
      from public.group_members m
      join public.groups g    on g.id = m.group_id
      join public.profiles p  on p.id = m.user_id
     where m.group_id = p_group_id
     order by (g.owner_id = p.id) desc, coalesce(m.is_admin, false) desc, p.nickname nulls last;
end;
$$;
grant execute on function public.gm2_list_group_members(text, uuid) to authenticated;

-- 9) 修改群主（新群主必须是群成员）
create or replace function public.gm2_set_group_owner(p_pwd text, p_group_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.user_id = p_new_owner_id
  ) then
    raise exception '新群主必须是该群成员';
  end if;
  update public.groups set owner_id = p_new_owner_id where id = p_group_id;
  update public.group_members set is_admin = false
   where group_id = p_group_id and user_id = p_new_owner_id;
end;
$$;
grant execute on function public.gm2_set_group_owner(text, uuid, uuid) to authenticated;

-- 10) 设置 / 取消群管理员
create or replace function public.gm2_set_group_admin(p_pwd text, p_group_id uuid, p_user_id uuid, p_is_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.user_id = p_user_id
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
grant execute on function public.gm2_set_group_admin(text, uuid, uuid, boolean) to authenticated;

-- 11) 称号管理（v291.1）：开发者 / 次级开发者可以
--       ① 创建称号
--       ② 授予 / 撤销任意称号 —— 仅「开发者」「次级开发者」两个开发者类称号不可操作
--       后缀 _v2911 用于同上兼容；这里全部是新名字，无需 drop。

drop function if exists public.gm2_list_titles(text) cascade;

create or replace function public.gm2_list_titles(p_pwd text)
returns table (
  id          uuid,
  name        text,
  description text,
  frame_color text,
  frame_style text,
  cond_type   text,
  usage_count bigint,
  locked      boolean,
  created_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  return query
    select t.id, t.name, t.description, t.frame_color, t.frame_style, t.cond_type,
           (select count(*) from public.user_titles ut where ut.title_id = t.id),
           (t.name in ('开发者', '次级开发者')),
           t.created_at
      from public.titles t
     order by (t.name in ('开发者', '次级开发者')) asc, t.created_at desc;
end;
$$;
grant execute on function public.gm2_list_titles(text) to authenticated;

-- 12) 某账号的称号清单（owned=true 表示已拥有，locked=true 表示不可操作）
drop function if exists public.gm2_list_titles_of_user(text, uuid) cascade;

create or replace function public.gm2_list_titles_of_user(p_pwd text, p_user_id uuid)
returns table (
  id          uuid,
  name        text,
  frame_color text,
  frame_style text,
  owned       boolean,
  locked      boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm2_check(p_pwd);
  return query
    select t.id, t.name, t.frame_color, t.frame_style,
           exists (select 1 from public.user_titles ut
                    where ut.user_id = p_user_id and ut.title_id = t.id),
           (t.name in ('开发者', '次级开发者'))
      from public.titles t
     order by (t.name in ('开发者', '次级开发者')) asc, t.name asc;
end;
$$;
grant execute on function public.gm2_list_titles_of_user(text, uuid) to authenticated;

-- 13) 创建称号（走 gm2 鉴权，开发者 / 次级开发者可用）
drop function if exists public.gm2_create_title(text, text, text, text, text, text, int) cascade;

create or replace function public.gm2_create_title(
  p_pwd text, p_name text, p_desc text, p_color text,
  p_style text, p_cond_type text, p_value int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  perform public.gm2_check(p_pwd);
  p_name := nullif(btrim(coalesce(p_name, '')), '');
  if p_name is null then raise exception '请输入称号名称'; end if;
  if p_name in ('开发者', '次级开发者') then
    raise exception '该称号为系统保留，不可创建';
  end if;
  if exists (select 1 from public.titles t where t.name = p_name) then
    raise exception '已存在同名称号';
  end if;
  insert into public.titles (name, description, frame_color, frame_style, cond_type, cond_value)
  values (
    p_name,
    nullif(btrim(coalesce(p_desc, '')), ''),
    coalesce(nullif(btrim(coalesce(p_color, '')), ''), '#ffd700'),
    coalesce(nullif(btrim(coalesce(p_style, '')), ''), 'ring'),
    coalesce(nullif(btrim(coalesce(p_cond_type, '')), ''), 'manual'),
    case when coalesce(p_cond_type, 'manual') in ('streak','total_login','clean_streak')
         then greatest(coalesce(p_value, 7), 1) else null end
  )
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.gm2_create_title(text, text, text, text, text, text, int) to authenticated;

-- 14) 授予 / 撤销称号（开发者类称号不可操作，交由 dev_grant_subdev 处理）
create or replace function public.gm2_set_user_title(p_pwd text, p_user_id uuid, p_title_id uuid, p_grant boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  perform public.gm2_check(p_pwd);
  select t.name into v_name from public.titles t where t.id = p_title_id;
  if v_name is null then raise exception '称号不存在'; end if;
  if v_name in ('开发者', '次级开发者') then
    raise exception '开发者类称号请通过「设为 / 撤销次级开发者」操作';
  end if;

  if coalesce(p_grant, true) then
    insert into public.user_titles (user_id, title_id, source, granted_by)
    values (p_user_id, p_title_id, 'manual', auth.uid())
    on conflict (user_id, title_id) do nothing;
    perform public.auto_equip_free_slot(p_user_id, p_title_id);
  else
    delete from public.user_titles where user_id = p_user_id and title_id = p_title_id;
    update public.profiles
       set display_title_id  = case when display_title_id  = p_title_id then null else display_title_id  end,
           display_title_id2 = case when display_title_id2 = p_title_id then null else display_title_id2 end
     where id = p_user_id;
  end if;
end;
$$;
grant execute on function public.gm2_set_user_title(text, uuid, uuid, boolean) to authenticated;

-- ============================================================
--  v293：简易后台并入 GM 后台
--    ① gm_check 放宽：持有开发者类称号（含次级开发者）即可通过，口令可省略；
--       次级开发者从此拥有与站长相同的 GM 后台 RPC 能力。
--    ② 例外（改用 gm_check_admin，仅站长）：
--         gm_get_group_messages / gm_get_dm_messages（聊天记录）
--    ③ 例外（函数内加保护，仅站长可操作开发者类称号）：
--         gm_grant_title / gm_revoke_title / gm_delete_title / gm_update_title
-- ============================================================

-- 15) 放宽 gm_check：角色 + 可选口令
create or replace function public.gm_check(p_pwd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.gm2_role();
  if v_role is null then
    raise exception 'GM_FORBIDDEN';
  end if;
  if p_pwd is not null and p_pwd <> '' and p_pwd is distinct from public.gm_password() then
    raise exception 'GM_AUTH_FAIL';
  end if;
end;
$$;
grant execute on function public.gm_check(text) to authenticated;

-- 16) 严格校验：仅站长 + 口令必填（聊天记录等敏感操作专用）
create or replace function public.gm_check_admin(p_pwd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (auth.uid()::uuid) is distinct from public.gm_admin_uid() then
    raise exception 'GM_FORBIDDEN';
  end if;
  if p_pwd is distinct from public.gm_password() then
    raise exception 'GM_AUTH_FAIL';
  end if;
end;
$$;
grant execute on function public.gm_check_admin(text) to authenticated;

-- 17) 聊天记录：仅站长可看（次级开发者不可查看聊天记录）
create or replace function public.gm_get_group_messages(p_pwd text, p_group_id uuid)
returns table (
  id               bigint,
  sender_id        uuid,
  sender_name      text,
  receiver_id      uuid,
  group_id         uuid,
  kind             text,
  content          text,
  file_path        text,
  file_name        text,
  file_size        bigint,
  created_at       timestamptz,
  recalled         boolean,
  deleted_by       uuid[],
  hidden_forbidden boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check_admin(p_pwd);
  return query
    select m.id,
           m.sender_id,
           sp.nickname,
           m.receiver_id,
           m.group_id,
           m.kind,
           coalesce(m.recalled_content, m.content) as content,
           coalesce(m.recalled_file_path, m.file_path) as file_path,
           coalesce(m.recalled_file_name, m.file_name) as file_name,
           coalesce(m.recalled_file_size, m.file_size) as file_size,
           m.created_at,
           m.recalled,
           m.deleted_by,
           m.hidden_forbidden
      from public.messages m
      left join public.profiles sp on sp.id = m.sender_id
     where m.group_id = p_group_id
     order by m.created_at asc;
end;
$$;
grant execute on function public.gm_get_group_messages(text, uuid) to authenticated;

create or replace function public.gm_get_dm_messages(p_pwd text, p_user_a uuid, p_user_b uuid)
returns table (
  id               bigint,
  sender_id        uuid,
  sender_name      text,
  receiver_id      uuid,
  group_id         uuid,
  kind             text,
  content          text,
  file_path        text,
  file_name        text,
  file_size        bigint,
  created_at       timestamptz,
  recalled         boolean,
  deleted_by       uuid[],
  hidden_forbidden boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check_admin(p_pwd);
  return query
    select m.id,
           m.sender_id,
           sp.nickname,
           m.receiver_id,
           m.group_id,
           m.kind,
           coalesce(m.recalled_content, m.content) as content,
           coalesce(m.recalled_file_path, m.file_path) as file_path,
           coalesce(m.recalled_file_name, m.file_name) as file_name,
           coalesce(m.recalled_file_size, m.file_size) as file_size,
           m.created_at,
           m.recalled,
           m.deleted_by,
           m.hidden_forbidden
      from public.messages m
      left join public.profiles sp on sp.id = m.sender_id
     where m.group_id is null
       and ((m.sender_id = p_user_a and m.receiver_id = p_user_b)
         or (m.sender_id = p_user_b and m.receiver_id = p_user_a))
     order by m.created_at asc;
end;
$$;
grant execute on function public.gm_get_dm_messages(text, uuid, uuid) to authenticated;

-- 18) 称号授予 / 撤销：开发者类称号仅站长可操作
create or replace function public.gm_grant_title(p_pwd text, p_user_id uuid, p_title_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  perform public.gm_check(p_pwd);
  select t.name into v_name from public.titles t where t.id = p_title_id;
  if v_name in ('开发者', '次级开发者') and public.gm2_role() is distinct from 'admin' then
    raise exception 'DEV_TITLE_ADMIN_ONLY';
  end if;
  insert into public.user_titles (user_id, title_id, source, granted_by)
  values (p_user_id, p_title_id, 'manual', auth.uid())
  on conflict (user_id, title_id) do nothing;
  perform public.auto_equip_free_slot(p_user_id, p_title_id);
end;
$$;
grant execute on function public.gm_grant_title(text, uuid, uuid) to authenticated;

create or replace function public.gm_revoke_title(p_pwd text, p_user_id uuid, p_title_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  perform public.gm_check(p_pwd);
  select t.name into v_name from public.titles t where t.id = p_title_id;
  if v_name in ('开发者', '次级开发者') and public.gm2_role() is distinct from 'admin' then
    raise exception 'DEV_TITLE_ADMIN_ONLY';
  end if;
  delete from public.user_titles where user_id = p_user_id and title_id = p_title_id;
  update public.profiles set display_title_id = (
    select title_id from public.user_titles where user_id = p_user_id order by granted_at desc limit 1
  ) where id = p_user_id and display_title_id = p_title_id;
end;
$$;
grant execute on function public.gm_revoke_title(text, uuid, uuid) to authenticated;

-- 19) 系统称号不可删除 / 不可改名（防止破坏开发者称号体系）
create or replace function public.gm_delete_title(p_pwd text, p_title_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_name text;
begin
  perform public.gm_check(p_pwd);
  select t.name into v_name from public.titles t where t.id = p_title_id;
  if v_name in ('开发者', '次级开发者') then
    raise exception '系统称号不可删除';
  end if;
  delete from public.titles where id = p_title_id;
end;
$$;
grant execute on function public.gm_delete_title(text, uuid) to authenticated;

create or replace function public.gm_update_title(
  p_pwd text,
  p_title_id uuid,
  p_name text,
  p_desc text,
  p_color text,
  p_style text,
  p_cond_type text,
  p_value int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  perform public.gm_check(p_pwd);
  if p_title_id is null then
    raise exception '称号 ID 不能为空';
  end if;
  select t.name into v_name from public.titles t where t.id = p_title_id;
  if v_name in ('开发者', '次级开发者') then
    raise exception '系统称号不可修改';
  end if;
  update public.titles
    set name = p_name,
        description = coalesce(nullif(p_desc, ''), null),
        frame_color = coalesce(nullif(p_color, ''), '#ffd700'),
        frame_style = coalesce(nullif(p_style, ''), 'ring'),
        cond_type = coalesce(nullif(p_cond_type, ''), 'manual'),
        cond_value = case when coalesce(p_cond_type, 'manual') in ('streak','total_login','clean_streak') then p_value else null end
  where id = p_title_id;
end;
$$;
grant execute on function public.gm_update_title(text, uuid, text, text, text, text, text, int) to authenticated;

notify pgrst, 'reload schema';


-- ============================================================
--  v294：问题反馈多条回复
--  来源：supabase/migrations/20260916_feedback_multi.sql
-- ============================================================
-- ============================================================================
--  v294：问题反馈多条回复 + 管理端已读「仅标记本端」
--  1) 开发者 / 次级开发者 / 站长可对同一条反馈各自回复（多条并存，互不覆盖）
--  2) 「标记已读」只对当前操作账号生效（feedback_admin_reads 按账号记录），
--     站长标了已读，开发者 / 次级开发者仍各自显示未读；用户端红点（reply_seen）
--     是用户自己的本端状态，管理端读不读不影响它。
--  幂等可重跑。依赖 public.feedback 已存在。
-- ============================================================================

-- 1) 反馈回复表：多条回复
create table if not exists public.feedback_replies (
  id          uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.feedback(id) on delete cascade,
  replier_id  uuid not null references public.profiles(id) on delete cascade,
  content     text not null,
  created_at  timestamptz not null default now()
);
alter table public.feedback_replies enable row level security;

-- 2) 管理端已读记录（每账号一行 → 已读仅本端生效）
create table if not exists public.feedback_admin_reads (
  feedback_id uuid not null references public.feedback(id) on delete cascade,
  admin_uid   uuid not null references public.profiles(id) on delete cascade,
  read_at     timestamptz not null default now(),
  primary key (feedback_id, admin_uid)
);
alter table public.feedback_admin_reads enable row level security;

-- 3) 回复反馈：追加一条回复（不再覆盖旧回复），并重置用户端红点
create or replace function public.gm_reply_feedback(p_pwd text, p_id uuid, p_reply text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  perform public.gm_check(p_pwd);
  if p_reply is null or trim(p_reply) = '' then
    raise exception 'REPLY_EMPTY';
  end if;
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  if not exists (select 1 from public.feedback f where f.id = p_id) then
    raise exception 'FEEDBACK_NOT_FOUND';
  end if;
  insert into public.feedback_replies(feedback_id, replier_id, content)
  values (p_id, v_uid, trim(p_reply));
  update public.feedback set reply_seen = false where id = p_id;
end;
$$;
grant execute on function public.gm_reply_feedback(text, uuid, text) to authenticated;

-- 4) GM 列出全部反馈：新增 read_by_me（本端是否已读）
drop function if exists public.gm_list_feedback(text);
create or replace function public.gm_list_feedback(p_pwd text)
returns table(
  id uuid, user_id uuid, nickname text, phone text,
  content text, contact text, created_at timestamptz, status text,
  dev_reply text, dev_reply_at timestamptz, dev_id uuid,
  read_by_me boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
  select f.id, f.user_id, p.nickname, p.phone, f.content, f.contact,
         f.created_at, f.status, f.dev_reply, f.dev_reply_at, f.dev_id,
         exists (
           select 1 from public.feedback_admin_reads ar
            where ar.feedback_id = f.id and ar.admin_uid = auth.uid()
         ) as read_by_me
  from public.feedback f
  join public.profiles p on p.id = f.user_id
  order by f.created_at desc;
end;
$$;
grant execute on function public.gm_list_feedback(text) to authenticated;

-- 5) GM 列出全部回复（前端按 feedback_id 分组渲染）
create or replace function public.gm_list_feedback_replies(p_pwd text)
returns table(
  reply_id uuid, feedback_id uuid, replier_id uuid,
  replier_name text, replier_role text,
  content text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
  select r.id, r.feedback_id, r.replier_id,
         coalesce(p.nickname, '(无昵称)') as replier_name,
         case
           when exists (
             select 1 from public.user_titles ut join public.titles t on t.id = ut.title_id
              where ut.user_id = r.replier_id and t.name in ('开发者','次级开发者')
           ) then 'dev'
           when public.gm_admin_uid() = r.replier_id then 'admin'
           else 'dev'
         end as replier_role,
         r.content, r.created_at
  from public.feedback_replies r
  left join public.profiles p on p.id = r.replier_id
  order by r.created_at asc;
end;
$$;
grant execute on function public.gm_list_feedback_replies(text) to authenticated;

-- 6) 标记已读：只写本账号记录，不动 status、不动其他管理端
create or replace function public.gm_mark_feedback_read(p_pwd text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  perform public.gm_check(p_pwd);
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  if not exists (select 1 from public.feedback f where f.id = p_id) then
    raise exception 'FEEDBACK_NOT_FOUND';
  end if;
  insert into public.feedback_admin_reads(feedback_id, admin_uid)
  values (p_id, v_uid)
  on conflict (feedback_id, admin_uid) do nothing;
end;
$$;
grant execute on function public.gm_mark_feedback_read(text, uuid) to authenticated;

-- 7) 删除单条回复（p_id = 回复 id）
drop function if exists public.gm_delete_feedback_reply(text, uuid);
create or replace function public.gm_delete_feedback_reply(p_pwd text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  delete from public.feedback_replies where id = p_id;
  if not found then
    raise exception 'REPLY_NOT_FOUND';
  end if;
end;
$$;
grant execute on function public.gm_delete_feedback_reply(text, uuid) to authenticated;

-- 8) 用户端：我的反馈（新增 has_reply：是否有任何回复）
drop function if exists public.get_my_feedback();
create or replace function public.get_my_feedback()
returns table(
  id uuid, content text, contact text, created_at timestamptz,
  status text, dev_reply text, dev_reply_at timestamptz, reply_seen boolean,
  has_reply boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  return query
  select f.id, f.content, f.contact, f.created_at, f.status,
         f.dev_reply, f.dev_reply_at, f.reply_seen,
         exists (
           select 1 from public.feedback_replies r where r.feedback_id = f.id
         ) as has_reply
  from public.feedback f
  where f.user_id = v_uid
  order by f.created_at desc;
end;
$$;
grant execute on function public.get_my_feedback() to authenticated;

-- 9) 用户端：本人全部反馈的回复列表（含回复人昵称 / 身份）
create or replace function public.get_my_feedback_replies()
returns table(
  reply_id uuid, feedback_id uuid, replier_name text, replier_role text,
  content text, created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NOT_AUTH';
  end if;
  return query
  select r.id, r.feedback_id,
         coalesce(p.nickname, '(无昵称)') as replier_name,
         case
           when exists (
             select 1 from public.user_titles ut join public.titles t on t.id = ut.title_id
              where ut.user_id = r.replier_id and t.name in ('开发者','次级开发者')
           ) then 'dev'
           when public.gm_admin_uid() = r.replier_id then 'admin'
           else 'dev'
         end as replier_role,
         r.content, r.created_at
  from public.feedback_replies r
  join public.feedback f on f.id = r.feedback_id
  left join public.profiles p on p.id = r.replier_id
  where f.user_id = v_uid
  order by r.created_at asc;
end;
$$;
grant execute on function public.get_my_feedback_replies() to authenticated;

notify pgrst, 'reload schema';


-- ============================================================
--  v296：群聊邀请码
--  来源：supabase/migrations/20260918_group_invite_code.sql
-- ============================================================
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


-- ============================================================
--  v297：广场点赞 / 收藏
--  来源：supabase/migrations/20260918_forum_like_fav.sql
-- ============================================================
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
