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

notify pgrst, 'reload schema';

select 'GM 查看用户永久好友码已就绪：gm_get_user_friend_code' as status;
