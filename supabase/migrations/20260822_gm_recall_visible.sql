-- ============================================================
--  20260822 GM 后台可查看撤回消息正文
--  需求：GM 在后台查看聊天记录时，撤回的消息仍要显示原文 / 原图 / 原视频 / 原文件。
--  实现：
--    1) messages 表新增 recalled_content / recalled_file_path / recalled_file_name / recalled_file_size，
--       在消息被首次标记为 recalled = true 时由触发器自动快照旧值。
--    2) gm_get_group_messages / gm_get_dm_messages 返回 coalesce(recalled_*, 当前值)，
--       使 GM 视角下撤回消息仍能看到原始内容。
--  幂等，可重复执行（在 Supabase 控制台 SQL Editor 全文粘贴 → Run）。
-- ============================================================

-- 1) 新增快照列
alter table public.messages
  add column if not exists recalled_content   text,
  add column if not exists recalled_file_path text,
  add column if not exists recalled_file_name text,
  add column if not exists recalled_file_size bigint;

-- 2) 触发器：首次设置 recalled = true 时，把旧正文/文件路径快照到 recalled_* 列
--    （客户端仍会把 content / file_path 等清空，触发器在清空前先备份 OLD 值）
create or replace function public.trg_messages_recall_snapshot()
returns trigger
language plpgsql
security definer
as $$
begin
  if NEW.recalled = true and (OLD.recalled is distinct from true) then
    NEW.recalled_content   := OLD.content;
    NEW.recalled_file_path := OLD.file_path;
    NEW.recalled_file_name := OLD.file_name;
    NEW.recalled_file_size := OLD.file_size;
  end if;
  return NEW;
end;
$$;

drop trigger if exists messages_recall_snapshot on public.messages;
create trigger messages_recall_snapshot
  before update on public.messages
  for each row
  when (NEW.recalled = true and OLD.recalled is distinct from true)
  execute function public.trg_messages_recall_snapshot();

-- 3) 更新 GM 聊天记录查看器：撤回消息返回快照内容（无快照则回退当前值）
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
  perform public.gm_check(p_pwd);
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
  perform public.gm_check(p_pwd);
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

select 'GM 后台撤回消息正文可见： recalled_* 快照列 + 触发器 + GM 查看器已就绪' as result;
