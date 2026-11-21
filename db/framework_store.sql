-- db/framework_store.sql
-- Mimamori Framework store (P1): tenant profiles, manuals, manual versions, Manual→Case links.
-- Requires db/case_store.sql (Case links reference care_cases).
--
-- Same rules as the Case store (ADR 0002, ADR 0016):
--   * every row and lookup is scoped by tenant_id
--   * RLS enabled; anon/authenticated have no access
--   * tables are read-only to service_role; all writes go through SECURITY DEFINER RPCs
--   * governance invariants (four-eyes approval, one approved version, immutable
--     reviewed content, append-only Case links) are enforced in the database too
-- Re-runnable.

create table if not exists public.framework_tenant_profiles (
  tenant_id text primary key check (tenant_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  sector text not null check (sector in ('care', 'education', 'healthcare', 'public')),
  pack_version text not null check (char_length(pack_version) between 1 and 40),
  display_name text not null check (char_length(display_name) between 1 and 80),
  updated_by text not null,
  updated_at timestamptz not null
);

create table if not exists public.framework_manuals (
  tenant_id text not null references public.framework_tenant_profiles (tenant_id),
  manual_id text not null check (manual_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  sector text not null check (sector in ('care', 'education', 'healthcare', 'public')),
  category text not null check (category ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  title text not null check (char_length(title) between 1 and 80),
  tags text[] not null default '{}' check (cardinality(tags) <= 10),
  template_ref text check (char_length(template_ref) <= 200),
  created_by text not null,
  created_at timestamptz not null,
  search_title text not null,
  search_tags text not null,
  primary key (tenant_id, manual_id)
);
create unique index if not exists framework_manuals_template_uidx
  on public.framework_manuals (tenant_id, template_ref) where template_ref is not null;

create table if not exists public.framework_manual_versions (
  tenant_id text not null,
  manual_id text not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'in_review', 'approved', 'superseded', 'retired', 'rejected')),
  summary text not null default '' check (char_length(summary) <= 500),
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 40),
  default_priority text not null check (default_priority in ('critical', 'high', 'normal', 'low')),
  change_note text not null default '' check (char_length(change_note) <= 500),
  fictional_template boolean not null default false,
  created_by text not null,
  created_at timestamptz not null,
  submitted_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  search_summary text not null,
  search_steps text not null,
  primary key (tenant_id, manual_id, version),
  foreign key (tenant_id, manual_id) references public.framework_manuals (tenant_id, manual_id),
  -- Four-eyes: the reviewer is never the author.
  check (reviewed_by is null or reviewed_by <> created_by),
  check (status not in ('approved', 'superseded', 'rejected') or (reviewed_by is not null and reviewed_at is not null)),
  check (status not in ('approved', 'superseded', 'retired') or effective_from is not null),
  check (effective_until is null or effective_from is null or effective_until >= effective_from)
);
-- At most one approved and one open (draft / in review) version per manual.
create unique index if not exists framework_manual_one_approved_uidx
  on public.framework_manual_versions (tenant_id, manual_id) where status = 'approved';
create unique index if not exists framework_manual_one_open_uidx
  on public.framework_manual_versions (tenant_id, manual_id) where status in ('draft', 'in_review');
create index if not exists framework_manual_versions_field_idx
  on public.framework_manual_versions (tenant_id, status, effective_from);

-- Reviewed content is immutable: only governance columns may change after submission.
create or replace function public.framework_guard_manual_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status <> 'draft' and (
       new.summary is distinct from old.summary
    or new.steps is distinct from old.steps
    or new.default_priority is distinct from old.default_priority
    or new.created_by is distinct from old.created_by
    or new.version is distinct from old.version
  ) then
    raise exception 'framework_manual_version_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists framework_manual_version_guard on public.framework_manual_versions;
create trigger framework_manual_version_guard
  before update on public.framework_manual_versions
  for each row execute function public.framework_guard_manual_version();

create table if not exists public.framework_case_links (
  tenant_id text not null,
  case_id text not null,
  manual_id text not null,
  manual_version integer not null,
  signal_id text not null check (signal_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  subject_ref text not null check (subject_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  linked_by text not null,
  linked_at timestamptz not null,
  primary key (tenant_id, case_id),
  unique (tenant_id, signal_id),
  foreign key (tenant_id, case_id) references public.care_cases (tenant_id, case_id),
  foreign key (tenant_id, manual_id, manual_version)
    references public.framework_manual_versions (tenant_id, manual_id, version)
);

alter table public.framework_tenant_profiles enable row level security;
alter table public.framework_manuals enable row level security;
alter table public.framework_manual_versions enable row level security;
alter table public.framework_case_links enable row level security;

revoke all on table public.framework_tenant_profiles, public.framework_manuals,
  public.framework_manual_versions, public.framework_case_links
  from public, anon, authenticated;
revoke insert, update, delete on table public.framework_tenant_profiles, public.framework_manuals,
  public.framework_manual_versions, public.framework_case_links
  from service_role;
grant select on table public.framework_tenant_profiles, public.framework_manuals,
  public.framework_manual_versions, public.framework_case_links
  to service_role;

-- ── JSON projections (camelCase, matches src/framework/types.ts) ──────────

create or replace function public.framework_manual_json(m public.framework_manuals)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'tenantId', m.tenant_id, 'manualId', m.manual_id, 'sector', m.sector, 'category', m.category,
    'title', m.title, 'tags', to_jsonb(m.tags), 'templateRef', m.template_ref,
    'createdBy', m.created_by, 'createdAt', m.created_at);
$$;

create or replace function public.framework_version_json(v public.framework_manual_versions)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'tenantId', v.tenant_id, 'manualId', v.manual_id, 'version', v.version, 'status', v.status,
    'summary', v.summary, 'steps', v.steps, 'defaultPriority', v.default_priority,
    'changeNote', v.change_note, 'fictionalTemplate', v.fictional_template,
    'createdBy', v.created_by, 'createdAt', v.created_at, 'submittedAt', v.submitted_at,
    'reviewedBy', v.reviewed_by, 'reviewedAt', v.reviewed_at,
    'effectiveFrom', v.effective_from, 'effectiveUntil', v.effective_until);
$$;

create or replace function public.framework_link_json(l public.framework_case_links)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'tenantId', l.tenant_id, 'caseId', l.case_id, 'manualId', l.manual_id,
    'manualVersion', l.manual_version, 'signalId', l.signal_id, 'subjectRef', l.subject_ref,
    'linkedBy', l.linked_by, 'linkedAt', l.linked_at);
$$;

-- ── Tenant profile ─────────────────────────────────────────────────

create or replace function public.framework_put_tenant_profile(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  insert into public.framework_tenant_profiles (tenant_id, sector, pack_version, display_name, updated_by, updated_at)
  values (p_payload->>'tenantId', p_payload->>'sector', p_payload->>'packVersion',
          p_payload->>'displayName', p_payload->>'updatedBy', (p_payload->>'updatedAt')::timestamptz)
  on conflict (tenant_id) do update
    set sector = excluded.sector, pack_version = excluded.pack_version,
        display_name = excluded.display_name, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.framework_get_tenant_profile(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('profile', (
    select jsonb_build_object('tenantId', p.tenant_id, 'sector', p.sector, 'packVersion', p.pack_version,
                              'displayName', p.display_name, 'updatedBy', p.updated_by, 'updatedAt', p.updated_at)
      from public.framework_tenant_profiles p where p.tenant_id = p_payload->>'tenantId'));
$$;

-- ── Manuals & versions ─────────────────────────────────────────────

create or replace function public.framework_create_manual(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m jsonb := p_payload->'manual';
  v jsonb := p_payload->'version';
begin
  if (v->>'version')::int <> 1 or v->>'status' <> 'draft'
     or v->>'tenantId' <> m->>'tenantId' or v->>'manualId' <> m->>'manualId' then
    return jsonb_build_object('conflict', 'version_status_changed');
  end if;
  begin
    insert into public.framework_manuals
      (tenant_id, manual_id, sector, category, title, tags, template_ref, created_by, created_at, search_title, search_tags)
    values (m->>'tenantId', m->>'manualId', m->>'sector', m->>'category', m->>'title',
            array(select jsonb_array_elements_text(coalesce(m->'tags', '[]'::jsonb))),
            m->>'templateRef', m->>'createdBy', (m->>'createdAt')::timestamptz,
            m->'search'->>'title', m->'search'->>'tags');
  exception when unique_violation then
    return jsonb_build_object('conflict', 'manual_exists');
  end;
  insert into public.framework_manual_versions
    (tenant_id, manual_id, version, status, summary, steps, default_priority, change_note,
     fictional_template, created_by, created_at, search_summary, search_steps)
  values (v->>'tenantId', v->>'manualId', 1, 'draft', coalesce(v->>'summary', ''), v->'steps',
          v->>'defaultPriority', coalesce(v->>'changeNote', ''), coalesce((v->>'fictionalTemplate')::boolean, false),
          v->>'createdBy', (v->>'createdAt')::timestamptz, v->'search'->>'summary', v->'search'->>'steps');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.framework_get_manual(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('manual', (
    select public.framework_manual_json(m) from public.framework_manuals m
     where m.tenant_id = p_payload->>'tenantId' and m.manual_id = p_payload->>'manualId'));
$$;

create or replace function public.framework_list_manuals(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('manuals', coalesce(jsonb_agg(public.framework_manual_json(m) order by m.manual_id), '[]'::jsonb))
    from public.framework_manuals m where m.tenant_id = p_payload->>'tenantId';
$$;

create or replace function public.framework_list_versions(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('versions', coalesce(jsonb_agg(public.framework_version_json(v) order by v.version), '[]'::jsonb))
    from public.framework_manual_versions v
   where v.tenant_id = p_payload->>'tenantId' and v.manual_id = p_payload->>'manualId';
$$;

create or replace function public.framework_get_version(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('version', (
    select public.framework_version_json(v) from public.framework_manual_versions v
     where v.tenant_id = p_payload->>'tenantId' and v.manual_id = p_payload->>'manualId'
       and v.version = (p_payload->>'version')::int));
$$;

create or replace function public.framework_add_manual_version(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v jsonb := p_payload->'version';
  v_next int;
begin
  perform 1 from public.framework_manuals
   where tenant_id = v->>'tenantId' and manual_id = v->>'manualId' for update;
  if not found then
    return jsonb_build_object('conflict', 'version_status_changed');
  end if;
  if exists (select 1 from public.framework_manual_versions
              where tenant_id = v->>'tenantId' and manual_id = v->>'manualId'
                and status in ('draft', 'in_review')) then
    return jsonb_build_object('conflict', 'open_revision_exists');
  end if;
  select coalesce(max(version), 0) + 1 into v_next from public.framework_manual_versions
   where tenant_id = v->>'tenantId' and manual_id = v->>'manualId';
  if (v->>'version')::int <> v_next or v->>'status' <> 'draft' then
    return jsonb_build_object('conflict', 'version_status_changed');
  end if;
  insert into public.framework_manual_versions
    (tenant_id, manual_id, version, status, summary, steps, default_priority, change_note,
     fictional_template, created_by, created_at, search_summary, search_steps)
  values (v->>'tenantId', v->>'manualId', v_next, 'draft', coalesce(v->>'summary', ''), v->'steps',
          v->>'defaultPriority', coalesce(v->>'changeNote', ''), coalesce((v->>'fictionalTemplate')::boolean, false),
          v->>'createdBy', (v->>'createdAt')::timestamptz, v->'search'->>'summary', v->'search'->>'steps');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.framework_transition_manual_version(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t_tenant text := p_payload->>'tenantId';
  t_manual text := p_payload->>'manualId';
  t_version int := (p_payload->>'version')::int;
  t_from text := p_payload->>'from';
  t_to text := p_payload->>'to';
  t_actor text := p_payload->>'actorId';
  t_at timestamptz := (p_payload->>'at')::timestamptz;
  t_until timestamptz := nullif(p_payload->>'effectiveUntil', '')::timestamptz;
  cur public.framework_manual_versions%rowtype;
begin
  -- Serialize governance changes per manual.
  perform 1 from public.framework_manuals where tenant_id = t_tenant and manual_id = t_manual for update;
  select * into cur from public.framework_manual_versions
   where tenant_id = t_tenant and manual_id = t_manual and version = t_version for update;
  if not found or cur.status <> t_from then
    return jsonb_build_object('conflict', 'version_status_changed');
  end if;

  if t_from = 'draft' and t_to = 'in_review' then
    update public.framework_manual_versions set status = 'in_review', submitted_at = t_at
     where tenant_id = t_tenant and manual_id = t_manual and version = t_version;
  elsif t_from = 'in_review' and t_to in ('approved', 'rejected') then
    if cur.created_by = t_actor then
      return jsonb_build_object('governance', 'self_review');
    end if;
    if t_to = 'approved' then
      update public.framework_manual_versions
         set status = 'superseded',
             effective_until = case when effective_until is not null and effective_until < t_at then effective_until else t_at end
       where tenant_id = t_tenant and manual_id = t_manual and status = 'approved';
      update public.framework_manual_versions
         set status = 'approved', reviewed_by = t_actor, reviewed_at = t_at,
             effective_from = t_at, effective_until = t_until
       where tenant_id = t_tenant and manual_id = t_manual and version = t_version;
    else
      update public.framework_manual_versions
         set status = 'rejected', reviewed_by = t_actor, reviewed_at = t_at
       where tenant_id = t_tenant and manual_id = t_manual and version = t_version;
    end if;
  elsif t_from = 'approved' and t_to = 'retired' then
    update public.framework_manual_versions set status = 'retired', effective_until = t_at
     where tenant_id = t_tenant and manual_id = t_manual and version = t_version;
  else
    return jsonb_build_object('conflict', 'version_status_changed');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── Field search (approved + effective only, AND of normalized terms) ─────
-- Score: title 5, tags 3, summary 2, steps 1 per matching term (mirrors src/framework/text.ts).

create or replace function public.framework_like_escape(p_term text)
returns text language sql immutable as $$
  select replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_');
$$;

create or replace function public.framework_search_manuals(p_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t_tenant text := p_payload->>'tenantId';
  t_terms text[] := array(select jsonb_array_elements_text(coalesce(p_payload->'terms', '[]'::jsonb)));
  t_category text := nullif(p_payload->>'category', '');
  t_limit int := least(greatest(coalesce((p_payload->>'limit')::int, 20), 1), 50);
  t_now timestamptz := (p_payload->>'now')::timestamptz;
  result jsonb;
begin
  with field as (
    select m.*, v.version, v.summary, v.fictional_template, v.search_summary, v.search_steps
      from public.framework_manuals m
      join public.framework_manual_versions v
        on v.tenant_id = m.tenant_id and v.manual_id = m.manual_id
     where m.tenant_id = t_tenant
       and v.status = 'approved'
       and v.effective_from <= t_now
       and (v.effective_until is null or v.effective_until > t_now)
       and (t_category is null or m.category = t_category)
  ), scored as (
    select f.*,
           (select coalesce(sum(
                (case when f.search_title like '%' || public.framework_like_escape(term) || '%' escape '\' then 5 else 0 end)
              + (case when f.search_tags like '%' || public.framework_like_escape(term) || '%' escape '\' then 3 else 0 end)
              + (case when f.search_summary like '%' || public.framework_like_escape(term) || '%' escape '\' then 2 else 0 end)
              + (case when f.search_steps like '%' || public.framework_like_escape(term) || '%' escape '\' then 1 else 0 end)), 0)
              from unnest(t_terms) as term) as score,
           (select bool_and(
                f.search_title || ' ' || f.search_tags || ' ' || f.search_summary || ' ' || f.search_steps
                  like '%' || public.framework_like_escape(term) || '%' escape '\')
              from unnest(t_terms) as term) as all_match,
           array_remove(array[
             case when exists (select 1 from unnest(t_terms) term where f.search_title like '%' || public.framework_like_escape(term) || '%' escape '\') then 'title' end,
             case when exists (select 1 from unnest(t_terms) term where f.search_tags like '%' || public.framework_like_escape(term) || '%' escape '\') then 'tags' end,
             case when exists (select 1 from unnest(t_terms) term where f.search_summary like '%' || public.framework_like_escape(term) || '%' escape '\') then 'summary' end,
             case when exists (select 1 from unnest(t_terms) term where f.search_steps like '%' || public.framework_like_escape(term) || '%' escape '\') then 'steps' end
           ], null) as matched_in
      from field f
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'manualId', s.manual_id, 'version', s.version, 'title', s.title, 'category', s.category,
           'tags', to_jsonb(s.tags), 'summary', s.summary, 'fictionalTemplate', s.fictional_template,
           'score', s.score, 'matchedIn', to_jsonb(s.matched_in))
           order by s.score desc, s.title, s.manual_id), '[]'::jsonb)
    into result
    from (select * from scored
           where cardinality(t_terms) = 0 or coalesce(all_match, false)
           order by score desc, title, manual_id
           limit t_limit) s;
  return jsonb_build_object('hits', result);
end;
$$;

-- ── Manual → Case links (append-only) ──────────────────────────────

create or replace function public.framework_link_case(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l jsonb := p_payload->'link';
  existing public.framework_case_links%rowtype;
begin
  select * into existing from public.framework_case_links
   where tenant_id = l->>'tenantId' and case_id = l->>'caseId';
  if found then
    if existing.manual_id <> l->>'manualId' or existing.manual_version <> (l->>'manualVersion')::int
       or existing.signal_id <> l->>'signalId' then
      return jsonb_build_object('conflict', 'case_link_mismatch');
    end if;
    return jsonb_build_object('created', false);
  end if;
  begin
    insert into public.framework_case_links
      (tenant_id, case_id, manual_id, manual_version, signal_id, subject_ref, linked_by, linked_at)
    values (l->>'tenantId', l->>'caseId', l->>'manualId', (l->>'manualVersion')::int, l->>'signalId',
            l->>'subjectRef', l->>'linkedBy', (l->>'linkedAt')::timestamptz);
  exception
    when unique_violation then return jsonb_build_object('conflict', 'case_link_mismatch');
    when foreign_key_violation then return jsonb_build_object('conflict', 'manual_version_stale');
  end;
  return jsonb_build_object('created', true);
end;
$$;

create or replace function public.framework_get_case_link(p_payload jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('link', (
    select public.framework_link_json(l) from public.framework_case_links l
     where l.tenant_id = p_payload->>'tenantId'
       and ((p_payload ? 'caseId' and l.case_id = p_payload->>'caseId')
         or (p_payload ? 'signalId' and l.signal_id = p_payload->>'signalId'))
     limit 1));
$$;

-- ── Privileges: service_role executes RPCs; clients never do ───────────

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.framework_put_tenant_profile(jsonb)',
    'public.framework_get_tenant_profile(jsonb)',
    'public.framework_create_manual(jsonb)',
    'public.framework_get_manual(jsonb)',
    'public.framework_list_manuals(jsonb)',
    'public.framework_list_versions(jsonb)',
    'public.framework_get_version(jsonb)',
    'public.framework_add_manual_version(jsonb)',
    'public.framework_transition_manual_version(jsonb)',
    'public.framework_search_manuals(jsonb)',
    'public.framework_link_case(jsonb)',
    'public.framework_get_case_link(jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

revoke execute on function public.framework_guard_manual_version() from public, anon, authenticated;
