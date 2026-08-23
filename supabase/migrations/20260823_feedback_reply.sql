-- ============================================================================
--  问题反馈「开发者回复」（反馈提交者可在「我的反馈」看到开发者的留言）
--  幂等可重跑。需在 Supabase SQL Editor 执行一次。
--  依赖 20260806_feedback.sql 已存在 public.feedback 表。
-- ============================================================================

-- 追加回复相关字段
alter table public.feedback add column if not exists dev_reply     text;
alter table public.feedback add column if not exists dev_reply_at  timestamptz;
alter table public.feedback add column if not exists dev_id        uuid references public.profiles(id) on delete set null;
alter table public.feedback add column if not exists reply_seen    boolean not null default false;

-- 开发者（GM 后台）回复某条反馈：写入留言并标记提交者未读
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
  if length(trim(p_reply)) < 1 then
    raise exception 'REPLY_TOO_SHORT';
  end if;
  update public.feedback
     set dev_reply = trim(p_reply),
         dev_reply_at = now(),
         dev_id = v_uid,
         reply_seen = false
   where id = p_id;
  if not found then
    raise exception 'FEEDBACK_NOT_FOUND';
  end if;
end;
$$;
grant execute on function public.gm_reply_feedback(text, uuid, text) to authenticated;

-- GM 列出全部反馈（含开发者回复），按时间倒序
drop function if exists public.gm_list_feedback(text);
create or replace function public.gm_list_feedback(p_pwd text)
returns table(
  id uuid, user_id uuid, nickname text, phone text,
  content text, contact text, created_at timestamptz, status text,
  dev_reply text, dev_reply_at timestamptz, dev_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gm_check(p_pwd);
  return query
  select f.id, f.user_id, p.nickname, p.phone, f.content, f.contact,
         f.created_at, f.status, f.dev_reply, f.dev_reply_at, f.dev_id
  from public.feedback f
  join public.profiles p on p.id = f.user_id
  order by f.created_at desc;
end;
$$;
grant execute on function public.gm_list_feedback(text) to authenticated;

-- 用户查看自己的反馈 + 开发者回复
create or replace function public.get_my_feedback()
returns table(
  id uuid, content text, contact text, created_at timestamptz,
  status text, dev_reply text, dev_reply_at timestamptz, reply_seen boolean
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
         f.dev_reply, f.dev_reply_at, f.reply_seen
  from public.feedback f
  where f.user_id = v_uid
  order by f.created_at desc;
end;
$$;
grant execute on function public.get_my_feedback() to authenticated;

-- 用户标记某条反馈的回复已读（消除红点）
create or replace function public.mark_feedback_reply_seen(p_id uuid)
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
  update public.feedback set reply_seen = true where id = p_id and user_id = v_uid;
end;
$$;
grant execute on function public.mark_feedback_reply_seen(uuid) to authenticated;
