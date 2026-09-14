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

notify pgrst, 'reload schema';
