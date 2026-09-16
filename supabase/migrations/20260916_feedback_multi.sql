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
