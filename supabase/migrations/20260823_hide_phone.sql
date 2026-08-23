-- v244: 隐藏手机号开关
-- 在 profiles 增加 hide_phone 列；默认 false（不隐藏）。
-- 前端在所有「向好友展示手机号」的位置（会话头部、好友列表、搜索结果、他人资料页）
-- 依据该列决定是否展示；手机号搜索分支也会过滤掉 hide_phone=true 的用户，
-- 使隐藏者无法被通过手机号找到。该列本身不敏感，可随好友关系查询一并返回。

alter table public.profiles add column if not exists hide_phone boolean not null default false;

comment on column public.profiles.hide_phone is '是否向好友隐藏手机号；true 时好友不可见其手机号，且无法通过手机号搜索到';
