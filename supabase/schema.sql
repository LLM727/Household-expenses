-- ============================================================================
-- 家庭记账本 Household-expenses · 数据库结构
-- 用法：在 Supabase 控制台左侧 SQL Editor 里，把本文件整段粘贴进去执行一次。
-- 说明：分类与账户的「初始数据」由前端写入（见 src/defaults.js），
--        好处是分类和关键词只维护一份，改完刷新即可生效，不用重新跑 SQL。
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. 表结构
-- ---------------------------------------------------------------------------

-- 家庭（一个家庭一行）
create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '我的家',
  invite_code text not null unique,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- 成员（每个登录用户在本系统里的档案，一对一 auth.users）
create table if not exists public.members (
  id           uuid primary key references auth.users (id) on delete cascade,
  family_id    uuid references public.families (id) on delete set null,
  display_name text not null,
  role         text not null default 'child' check (role in ('father', 'mother', 'child', 'other')),
  created_at   timestamptz not null default now()
);

-- 账户（现金/微信/银行卡…），转账和余额靠它
create table if not exists public.accounts (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families (id) on delete cascade,
  name            text not null,
  kind            text not null default 'cash',
  initial_balance numeric(12, 2) not null default 0,
  archived        boolean not null default false,
  created_at      timestamptz not null default now()
);

-- 分类（两级：parent_id 为空是大类，否则是小类）
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families (id) on delete cascade,
  parent_id  uuid references public.categories (id) on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('expense', 'income')),
  icon       text,
  keywords   text[] not null default '{}',
  sort       int not null default 100,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);

-- 账目
-- kind 取值见 src/defaults.js：
--   expense/income            计入家庭收支合计
--   transfer/lend/lend_return/borrow/borrow_return  不计入合计，只影响账户与债权债务
--   reimburse_back            报销回款，冲减对应支出，不作为收入
create table if not exists public.transactions (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families (id) on delete cascade,
  kind           text not null check (kind in (
                   'expense', 'income', 'transfer', 'lend', 'lend_return',
                   'borrow', 'borrow_return', 'reimburse_back')),
  amount         numeric(12, 2) not null check (amount >= 0),
  occurred_on    date not null,                          -- 发生日期，支持补录
  category_id    uuid references public.categories (id) on delete set null,
  member_id      uuid references public.members (id) on delete set null,      -- 这笔账属于谁
  account_id     uuid references public.accounts (id) on delete set null,      -- 转出/付款账户
  to_account_id  uuid references public.accounts (id) on delete set null,      -- 转账转入账户
  note           text not null default '',
  raw_input      text not null default '',                -- 原始语音/文字，便于回溯
  reimbursable   boolean not null default false,          -- 垫付待报销
  reimburse_of   uuid references public.transactions (id) on delete set null, -- 冲减哪一笔支出
  created_by     uuid references auth.users (id) on delete set null,          -- 谁记的账
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 预算（month 形如 2026-11；category_id 为空表示该月总预算）
create table if not exists public.budgets (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  month       text not null,
  category_id uuid references public.categories (id) on delete cascade,
  amount      numeric(12, 2) not null check (amount >= 0),
  created_at  timestamptz not null default now()
);
create unique index if not exists budgets_unique_idx
  on public.budgets (family_id, month, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- 常用查询索引
create index if not exists transactions_family_date_idx
  on public.transactions (family_id, occurred_on desc);
create index if not exists transactions_family_kind_idx
  on public.transactions (family_id, kind);
create index if not exists categories_family_idx
  on public.categories (family_id, kind, sort);

-- ---------------------------------------------------------------------------
-- 2. 辅助函数
-- ---------------------------------------------------------------------------

-- 当前登录用户所属家庭。security definer 是为了避免 members 表策略自我递归。
create or replace function public.current_family_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select family_id from public.members where id = auth.uid();
$$;

-- 随机邀请码（6 位，去掉容易混淆的 0/O/1/I）
create or replace function public.gen_invite_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := '';
  i int;
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return code;
end;
$$;

-- updated_at 自动维护
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists transactions_touch on public.transactions;
create trigger transactions_touch
  before update on public.transactions
  for each row execute function public.touch_updated_at();

-- 防止任何人把自己「挪」到别人家里：改 family_id 只允许由下面的 RPC 触发
create or replace function public.members_guard_family()
returns trigger
language plpgsql
as $$
begin
  if new.family_id is distinct from old.family_id
     and coalesce(current_setting('app.allow_family_change', true), 'off') <> 'on' then
    raise exception '不能自己修改所属家庭，请用邀请码加入';
  end if;
  return new;
end;
$$;

drop trigger if exists members_guard_family on public.members;
create trigger members_guard_family
  before update on public.members
  for each row execute function public.members_guard_family();

-- ---------------------------------------------------------------------------
-- 3. 建家 / 入家（RPC，避开 members 表的插入限制）
-- ---------------------------------------------------------------------------

-- 创建一个新家庭，并把自己设为成员。返回家庭信息（含邀请码）。
create or replace function public.create_family(
  p_family_name  text,
  p_display_name text,
  p_role         text default 'father'
)
returns public.families
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family public.families;
  v_code text;
  v_existing uuid;
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;

  select family_id into v_existing from public.members where id = auth.uid();
  if v_existing is not null then
    raise exception '你已经在某个家庭里了';
  end if;

  perform set_config('app.allow_family_change', 'on', true);

  loop
    v_code := public.gen_invite_code();
    exit when not exists (select 1 from public.families where invite_code = v_code);
  end loop;

  insert into public.families (name, invite_code, created_by)
  values (coalesce(nullif(trim(p_family_name), ''), '我的家'), v_code, auth.uid())
  returning * into v_family;

  insert into public.members (id, family_id, display_name, role)
  values (auth.uid(), v_family.id, coalesce(nullif(trim(p_display_name), ''), '我'), coalesce(p_role, 'father'))
  on conflict (id) do update
    set family_id = excluded.family_id,
        display_name = excluded.display_name,
        role = excluded.role;

  return v_family;
end;
$$;

-- 用邀请码加入已有家庭。
create or replace function public.join_family_by_code(
  p_code         text,
  p_display_name text,
  p_role         text default 'child'
)
returns public.families
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family public.families;
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;

  select * into v_family
  from public.families
  where invite_code = upper(trim(p_code));

  if v_family.id is null then
    raise exception '邀请码不对，请向家人要一个最新的';
  end if;

  perform set_config('app.allow_family_change', 'on', true);

  insert into public.members (id, family_id, display_name, role)
  values (auth.uid(), v_family.id, coalesce(nullif(trim(p_display_name), ''), '家人'), coalesce(p_role, 'child'))
  on conflict (id) do update
    set family_id = excluded.family_id,
        display_name = excluded.display_name,
        role = excluded.role;

  return v_family;
end;
$$;

grant execute on function public.create_family(text, text, text) to authenticated;
grant execute on function public.join_family_by_code(text, text, text) to authenticated;
grant execute on function public.current_family_id() to authenticated;

-- 允许未登录者「调用」这两个函数是有意为之，不是漏洞：
--   1) 函数第一句就检查 auth.uid()，未登录直接抛「未登录」，做不了任何事；
--   2) PostgREST 只暴露「当前角色有权执行」的函数，如果没这条授权，
--      自检脚本（tools/check-config.js）就分不清「函数没建」还是「只是没权限」。
grant execute on function public.create_family(text, text, text) to anon;
grant execute on function public.join_family_by_code(text, text, text) to anon;

-- ---------------------------------------------------------------------------
-- 4. 行级权限（RLS）：每个家庭只能看到自己家的数据
-- ---------------------------------------------------------------------------

alter table public.families     enable row level security;
alter table public.members      enable row level security;
alter table public.accounts     enable row level security;
alter table public.categories   enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets      enable row level security;

-- families：只能看到自己家
drop policy if exists families_read on public.families;
create policy families_read on public.families
  for select to authenticated
  using (id = public.current_family_id());

drop policy if exists families_update on public.families;
create policy families_update on public.families
  for update to authenticated
  using (id = public.current_family_id())
  with check (id = public.current_family_id());

-- members：能看到同一家的人；只能改自己那行
drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select to authenticated
  using (family_id = public.current_family_id() or id = auth.uid());

drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and family_id is not distinct from public.current_family_id());

drop policy if exists members_delete_self on public.members;
create policy members_delete_self on public.members
  for delete to authenticated
  using (id = auth.uid());

-- 其余四张表：同一家庭的成员可读可写
do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'categories', 'transactions', 'budgets'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format(
      'create policy %I_read on public.%I for select to authenticated using (family_id = public.current_family_id())',
      t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated with check (family_id = public.current_family_id())',
      t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update to authenticated using (family_id = public.current_family_id()) with check (family_id = public.current_family_id())',
      t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete to authenticated using (family_id = public.current_family_id())',
      t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 校验
-- ---------------------------------------------------------------------------
-- 执行完可以跑下面这句，应看到 6 张表全部 rowsecurity = true
-- select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename;
