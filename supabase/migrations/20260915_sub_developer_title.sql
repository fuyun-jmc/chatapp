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
