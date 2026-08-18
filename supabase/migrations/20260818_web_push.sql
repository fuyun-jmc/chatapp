-- ============================================================
-- 2026-08-18 · Web Push 订阅存储
-- 配合前端 PWA（manifest + Service Worker）与 Supabase Edge Function
-- （notify-push）实现「手机系统浏览器锁屏/关页也能在通知中心收消息」。
--
-- 说明：
--   - 前端在「设置 → 开启消息推送」时，调用 upsert_push_subscription
--     把自己的浏览器订阅（endpoint/p256dh/auth）存到这里。
--   - 发送消息成功后，前端调用 Edge Function notify-push，
--     Edge Function 用 service_role 直接查本表，向接收者推送。
--   - 退订时前端调用 delete_push_subscription。
-- ============================================================

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;

-- 普通登录用户只能管理自己的订阅（前端直表操作也安全）
drop policy if exists "push_subs_owner_all" on public.push_subscriptions;
create policy "push_subs_owner_all" on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 存 / 更新当前用户的订阅（按 endpoint 唯一合并，换设备/重订阅安全覆盖）
create or replace function public.upsert_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NO_AUTH'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id    = excluded.user_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        updated_at = now();
end;
$$;
grant execute on function public.upsert_push_subscription(text, text, text) to authenticated;

-- 退订：删除当前用户指定 endpoint 的订阅
create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NO_AUTH'; end if;
  delete from public.push_subscriptions
   where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;
grant execute on function public.delete_push_subscription(text) to authenticated;

select 'Web Push 订阅存储已就绪';
