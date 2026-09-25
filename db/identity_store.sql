-- Mimamori Care Ops — production identity / membership store
-- Reference schema. Apply only to an intentionally provisioned project.

create table if not exists public.care_tenant_memberships (
  tenant_id text not null,
  principal_id text not null,
  actor_id text not null,
  roles text[] not null check (
    cardinality(roles) >= 1
    and roles <@ array[
      'dispatcher',
      'responder',
      'supervisor',
      'auditor'
    ]::text[]
  ),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, principal_id),
  unique (tenant_id, actor_id)
);

create index if not exists care_memberships_tenant_active_idx
  on public.care_tenant_memberships (tenant_id, active, actor_id);

alter table public.care_tenant_memberships enable row level security;

revoke all on table public.care_tenant_memberships
  from public, anon, authenticated;

revoke insert, update, delete on table public.care_tenant_memberships
  from service_role;

grant select on table public.care_tenant_memberships
  to service_role;
