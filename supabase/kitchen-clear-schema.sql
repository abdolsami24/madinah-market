-- ============================================================================
-- Madinah Market — Kitchen "Clear orders" (GloriaFood-style), 2026-11-26.
-- Run this ONCE in your Supabase project: SQL Editor -> New query ->
-- paste this whole file -> Run.
--
-- What it does: allows ONE new kitchen_status value, 'cleared'. The
-- kitchen screen's options menu (⋮ -> Clear orders) sets today's
-- on-screen orders to 'cleared'; the kitchen feed then stops returning
-- them, so the tablet empties and stays empty — while the orders
-- themselves stay in the database, Admin and reports (nothing is
-- deleted). Orders placed after the clear are unaffected.
--
-- Until this file is run, the Clear button simply shows a friendly
-- "not switched on yet" message on the kitchen screen — nothing
-- breaks and nothing is cleared.
--
-- Safe to re-run: it drops whichever kitchen_status CHECK constraint
-- is currently on the orders table and re-adds the full list.
-- ============================================================================

do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where rel.relname = 'orders'
      and nsp.nspname = 'public'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%kitchen_status%'
  loop
    execute format('alter table public.orders drop constraint %I', c);
  end loop;
end $$;

alter table public.orders
  add constraint orders_kitchen_status_check
  check (kitchen_status in ('new', 'accepted', 'preparing', 'ready', 'completed', 'cancelled', 'cleared'));
