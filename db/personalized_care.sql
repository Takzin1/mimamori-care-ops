-- Reference migration only; apply after identity_store.sql on an isolated test DB.
-- No direct Data API access. Production requires scoped, transactional RPCs.
begin;
create schema if not exists personalized_care;
revoke all on schema personalized_care from public, anon, authenticated, service_role;
create table personalized_care.facility (
 tenant_id text not null, facility_id text not null, primary key(tenant_id,facility_id)
);
create table personalized_care.facility_membership (
 tenant_id text not null, facility_id text not null, principal_id text not null,
 roles text[] not null check(cardinality(roles)>0 and roles <@ array['supervisor','dispatcher','responder','auditor']::text[]), active boolean not null default true,
 primary key(tenant_id,facility_id,principal_id),
 foreign key(tenant_id,facility_id) references personalized_care.facility,
 foreign key(tenant_id,principal_id) references public.care_tenant_memberships(tenant_id,principal_id)
);
create table personalized_care.resident (
 tenant_id text not null, facility_id text not null, resident_id text not null,
 display_name text not null, room_number text not null, preferred_name text not null,
 consent_status text not null check(consent_status in ('granted','pending','withdrawn')),
 profile_version bigint not null check(profile_version>0), updated_at timestamptz not null, updated_by text not null,
 primary key(tenant_id,facility_id,resident_id), foreign key(tenant_id,facility_id) references personalized_care.facility
);
create table personalized_care.preference (
 tenant_id text not null, facility_id text not null,resident_id text not null,preference_id text not null,
 category text not null,value text not null,source_type text not null check(source_type in ('resident','staff_observation','unconfirmed')),
 source_reference text not null,verification_status text not null check(verification_status in ('verified','pending','withdrawn')),
 effective_from timestamptz not null,expires_at timestamptz,approved_by text,updated_at timestamptz not null,
 primary key(tenant_id,facility_id,preference_id), foreign key(tenant_id,facility_id,resident_id) references personalized_care.resident on delete cascade,
 check(expires_at is null or expires_at>effective_from),
 check(verification_status<>'verified' or (source_type<>'unconfirmed' and approved_by is not null))
);
create table personalized_care.sop (
 tenant_id text not null,facility_id text not null,sop_id text not null,version bigint not null check(version>0),revision bigint not null check(revision>0),
 category text not null,title text not null,description text not null,definition jsonb not null check(jsonb_typeof(definition)='object'),
 approval_status text not null check(approval_status in ('DRAFT','IN_REVIEW','APPROVED','ARCHIVED')),effective_from timestamptz not null,approved_by text,source_reference text not null,
 primary key(tenant_id,facility_id,sop_id,version),foreign key(tenant_id,facility_id) references personalized_care.facility,check(approval_status<>'APPROVED' or approved_by is not null)
);
create unique index pc_sop_single_approved on personalized_care.sop(tenant_id,facility_id,sop_id) where approval_status='APPROVED';
create table personalized_care.interaction (
 tenant_id text not null,facility_id text not null,interaction_id text not null,resident_id text not null,actor_id text not null,interaction_type text not null,
 sop_id text,sop_version bigint,resident_context_version bigint not null,action_summary text not null,
 status text not null check(status in ('RECORDED','FOLLOWUP')),followup_required boolean not null,related_case_id text,version bigint not null default 1,created_at timestamptz not null,
 confirmed_checks jsonb not null,guide_snapshot jsonb not null,idempotency_digest text not null,promotion_priority text,
 primary key(tenant_id,facility_id,interaction_id),foreign key(tenant_id,facility_id,resident_id) references personalized_care.resident,
 foreign key(tenant_id,facility_id,sop_id,sop_version) references personalized_care.sop,
 check((sop_id is null)=(sop_version is null)),check(followup_required=(status='FOLLOWUP'))
);
create table personalized_care.audit (
 event_id bigint generated always as identity primary key,tenant_id text not null,facility_id text not null,actor_id text not null,action text not null,object_ref text not null,event_at timestamptz not null,
 foreign key(tenant_id,facility_id) references personalized_care.facility
);
do $$ declare n text; begin
 foreach n in array array['facility','facility_membership','resident','preference','sop','interaction','audit'] loop
  execute format('alter table personalized_care.%I enable row level security',n);
  execute format('alter table personalized_care.%I force row level security',n);
  execute format('revoke all on personalized_care.%I from public, anon, authenticated, service_role',n);
 end loop;
end $$;
revoke all on all sequences in schema personalized_care from public, anon, authenticated, service_role;
commit;
