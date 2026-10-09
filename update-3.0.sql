-- =====================================================================
-- Order Desk 3.0: arrange the menu
-- • menu.sort: the order your customers see dishes (set in Menu > Arrange).
-- Paste into Supabase > SQL Editor > New query > Run. Safe to run again.
-- =====================================================================
alter table public.menu add column if not exists sort integer;
select 'Order Desk 3.0 ready' as result;
