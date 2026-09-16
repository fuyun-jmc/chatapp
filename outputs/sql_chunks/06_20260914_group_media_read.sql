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
