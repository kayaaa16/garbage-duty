-- ============================================================
-- 垃圾輪值排班工具 — 雲端存檔（免登入）
-- 單一張表，存「整包 App 狀態 JSON」。
--
-- ⚠ 安全說明：本檔【只新增一張新表 garbage_duty_state 與它自己的
--   RLS policy】，完全不會更動 BMS 既有的任何資料表、資料或權限。
--   可安全地在 Supabase SQL Editor 一次執行。
-- ============================================================

create table if not exists public.garbage_duty_state (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.garbage_duty_state enable row level security;

-- 免登入：允許匿名（anon）讀寫「這張表」。不影響其他表。
drop policy if exists garbage_public_select on public.garbage_duty_state;
create policy garbage_public_select
  on public.garbage_duty_state for select using (true);

drop policy if exists garbage_public_insert on public.garbage_duty_state;
create policy garbage_public_insert
  on public.garbage_duty_state for insert with check (true);

drop policy if exists garbage_public_update on public.garbage_duty_state;
create policy garbage_public_update
  on public.garbage_duty_state for update using (true) with check (true);

-- 確保匿名角色有資料表權限（SQL 建表時需要明確 grant）
grant select, insert, update on public.garbage_duty_state to anon, authenticated;

-- 種一筆初始空資料（id = 'main'）
insert into public.garbage_duty_state (id, data)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;
