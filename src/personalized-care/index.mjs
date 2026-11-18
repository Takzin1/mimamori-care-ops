// Isolated P0 slice: memory or explicitly supplied synthetic snapshot repository.
import { retrieveSopEvidence, knowledgeCoverage } from "./knowledge.mjs";
import { educationFields, lessonEvidence, reviewSchedule, learnerView } from "./academy.mjs";

export const categories=["hospitality","greeting","request","life_consultation","room_visit","outing","family","equipment","complaint","report","handover","checkin","irregular","emergency"];

const roles=["supervisor","dispatcher","responder"];

const clone=x=>JSON.parse(JSON.stringify(x));

function fail(code,status=400){throw Object.assign(new Error(code),{status});}

function id(x){if(typeof x!=="string"||!/^[A-Za-z0-9._:-]{1,64}$/.test(x))fail("INVALID_ID");return x;}

function str(x,max=500){if(typeof x!=="string"||!x.trim()||x.length>max)fail("INVALID_TEXT");return x.trim();}

function list(x){if(!Array.isArray(x)||x.length>30)fail("INVALID_LIST");return x.map(v=>str(v));}

function categoryList(x){const values=list(x).map(c=>one(c,categories));if(!values.length)fail("INVALID_LIST");return [...new Set(values)].sort(cmp);}

function one(x,allowed){if(!allowed.includes(x))fail("INVALID_ENUM");return x;}

function instant(x){if(typeof x!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(x)||!Number.isFinite(Date.parse(x)))fail("INVALID_TIME");const canonical=new Date(x).toISOString();if(canonical!==x.replace(/Z$/,x.includes(".")?"Z":".000Z"))fail("INVALID_TIME");return canonical;}

function ver(x,min=0){if(!Number.isSafeInteger(x)||x<min)fail("INVALID_VERSION");return x;}

function obj(x){if(!x||typeof x!=="object"||Array.isArray(x))fail("INVALID_OBJECT");return x;}

function cmp(a,b){return a<b?-1:a>b?1:0;}

function activeAt(p,t){return p.effective_from<=t&&(!p.expires_at||p.expires_at>t);}

export function resolveGuide({profile,preferences,sops,category,actorRoles,asOf,currentChoice=null}){
  asOf=instant(asOf);one(category,categories);
  if(profile.consent_status!=="granted")fail("NOT_FOUND",404);
  const same=x=>x.tenant_id===profile.tenant_id&&x.facility_id===profile.facility_id;
  const candidates=sops.filter(s=>same(s)&&s.category===category&&s.approval_status==="APPROVED"&&s.effective_from<=asOf).sort((a,b)=>cmp(a.sop_id,b.sop_id)||b.version-a.version);
  const active=preferences.filter(p=>same(p)&&p.resident_id===profile.resident_id&&activeAt(p,asOf)&&p.applies_to.includes(category)).sort((a,b)=>cmp(a.preference_id,b.preference_id));
  const wishes=active.filter(p=>p.verification_status==="verified"&&p.source_type==="resident");
  const observations=active.filter(p=>p.verification_status==="verified"&&p.source_type==="staff_observation");
  const sop=candidates.length===1&&candidates[0].allowed_roles.some(r=>actorRoles.includes(r))?candidates[0]:null, conflicts=[], unresolved_questions=[];
  for(const p of wishes){
    if(wishes.some(q=>q.category===p.category&&q.value!==p.value)||currentChoice?.category===p.category&&currentChoice.value!==p.value)conflicts.push({category:p.category,reason:"WISH_CONFLICT"});
  }
  const constraints=(profile.approved_care_constraints??[]).filter(c=>c.applies_to.includes(category));
  for(const p of [...wishes,...(currentChoice?[currentChoice]:[])]){
    if(candidates.some(s=>s.prohibited_values.some(v=>v.category===p.category&&v.value===p.value)))conflicts.push({category:p.category,reason:"SOP_CONFLICT"});
    if(constraints.some(c=>c.category===p.category&&c.prohibited_value===p.value))conflicts.push({category:p.category,reason:"CARE_CONSTRAINT_CONFLICT"});
  }
  for(const p of active.filter(p=>p.verification_status==="pending"))unresolved_questions.push("未確認の情報："+p.category);
  if(!wishes.length)unresolved_questions.push("本人の現在の希望を確認してください。");
  if(!sop)unresolved_questions.push(candidates.length?"複数の手順が該当。責任者へ確認。":"承認済み手順なし。責任者へ確認。");
  const blocked=!sop||conflicts.length>0||["emergency","irregular"].includes(category);
  const guide_token=JSON.stringify([profile.tenant_id,profile.facility_id,profile.resident_id,profile.profile_version,[...actorRoles].sort(cmp),category,sop?.sop_id??null,sop?.version??null,active.map(p=>p.preference_id),currentChoice,blocked]);
  return {guide_token,approved_constraints:constraints,applicable_sop:sop?.sop_id??null,sop_version:sop?.version??null,resident_context_version:profile.profile_version,standard_steps:sop?.steps??[],personalized_considerations:wishes.filter(p=>!conflicts.some(c=>c.category===p.category)).map(p=>({category:p.category,value:p.value,source_reference:p.source_reference})),observed_facts:observations.map(p=>({category:p.category,value:p.value,source_reference:p.source_reference})),required_confirmations:sop?.required_checks??[],escalation_conditions:sop?.escalation_conditions??[],prohibited_actions:sop?.prohibited_actions??[],completion_requirements:sop?.completion_requirements??[],unresolved_questions,evidence_references:[...(sop?[sop.source_reference]:[]),...wishes.map(p=>p.source_reference),...observations.map(p=>p.source_reference),...constraints.map(c=>c.source_reference)],conflicts,human_review_required:true,blocked};
}

// Synthetic snapshot format v1; scope rows are validated on load before use.
export function encodeSnapshot(store){
  return JSON.stringify({format:1,profiles:[...store.profiles],preferences:[...store.preferences],sops:[...store.sops],logs:[...store.logs],lessons:[...(store.lessons??new Map())],learning:[...(store.learning??new Map())],audit:store.audit});
}
export function decodeSnapshot(payload,t,f){
  let raw;try{raw=JSON.parse(payload);}catch{fail("SNAPSHOT_CORRUPT",500);}
  if(!raw||raw.format!==1||!Array.isArray(raw.audit))fail("SNAPSHOT_CORRUPT",500);
  const scope=x=>x&&x.tenant_id===t&&x.facility_id===f;
  const result={audit:raw.audit};
  for(const [name,key] of [["profiles","resident_id"],["preferences","preference_id"],["sops","sop_id"],["logs","interaction_id"],["lessons","lesson_id"],["learning","progress_key"]]){
    const rows=Object.hasOwn(raw,name)?raw[name]:["lessons","learning"].includes(name)?[]:undefined;if(!Array.isArray(rows))fail("SNAPSHOT_CORRUPT",500);
    const map=new Map();
    for(const entry of rows){
      if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=="string"||map.has(entry[0]))fail("SNAPSHOT_CORRUPT",500);
      const [k,value]=entry,items=name==="sops"?value:[value];
      if(!Array.isArray(items)||!items.length||!items.every(v=>scope(v)&&v[key]===k))fail("SNAPSHOT_CORRUPT",500);
      map.set(k,value);
    }
    result[name]=map;
  }
  for(const v of [...result.preferences.values(),...result.logs.values()])if(!result.profiles.has(v.resident_id))fail("SNAPSHOT_CORRUPT",500);
  for(const p of result.learning.values())if(p.progress_key!==JSON.stringify([p.actor_id,p.lesson_id])||!result.lessons.has(p.lesson_id))fail("SNAPSHOT_CORRUPT",500);
  return result;
}

export class PersonalizedCareService {
  #auth;#members;#grant;#case;#binding;#clock;#snapshots;#scopes=new Map();#pending=new Set();
  constructor({authenticator,memberships,facilityGrant,caseService=null,caseBinding=async()=>null,clock=()=>new Date().toISOString(),snapshotRepository=null}){this.#auth=authenticator;this.#members=memberships;this.#grant=facilityGrant;this.#case=caseService;this.#binding=caseBinding;this.#clock=clock;this.#snapshots=snapshotRepository;}
  #now(){return instant(this.#clock());}
  async #authorize(req,admin=false){
    const t=id(req.tenant_id),f=id(req.facility_id);
    if(typeof req.accessToken!=="string"||!req.accessToken||req.accessToken.length>8192)fail("AUTH_REQUIRED",401);
    let p;try{p=await this.#auth.authenticate(req.accessToken,{tenant_id:t,facility_id:f});}catch{fail("AUTH_REQUIRED",401);}
    const m=await this.#members.findByPrincipal(t,p.principalId),g=await this.#grant(t,f,p.principalId);
    if(!m?.active||m.tenantId!==t||m.principalId!==p.principalId||!g?.active||g.tenant_id!==t||g.facility_id!==f||g.principal_id!==p.principalId||!Array.isArray(g.roles))fail("NOT_FOUND",404);
    const r=m.roles.filter(x=>roles.includes(x)&&g.roles.includes(x));
    if(!r.length||admin&&!r.includes("supervisor"))fail("FORBIDDEN",403);
    const key=JSON.stringify([t,f]);
    const fresh=()=>({profiles:new Map(),preferences:new Map(),sops:new Map(),logs:new Map(),lessons:new Map(),learning:new Map(),audit:[]});
    if(this.#snapshots){const context={principalId:p.principalId,actorId:id(m.actorId),roles:[...r],provider:p.provider,lineBinding:p.lineBinding??null};const raw=await this.#snapshots.load(t,f,context);const store=raw?decodeSnapshot(raw.payload,t,f):fresh();return {t,f,key,actor:context.actorId,roles:r,store,context,snapshotVersion:raw?.version??0};}
    if(!this.#scopes.has(key))this.#scopes.set(key,fresh());
    return {t,f,key,actor:id(m.actorId),roles:r,store:this.#scopes.get(key)};
  }
  async #audit(a,action,ref){
    a.store.audit.push({action,ref,actor_id:a.actor,at:this.#now()});
    // A snapshot adapter may be asynchronous. Do not return data or success before commit.
    if(this.#snapshots)a.snapshotVersion=await this.#snapshots.save(a.t,a.f,a.snapshotVersion,encodeSnapshot(a.store),a.context);
  }
  #profile(a,r,usable=true){const p=a.store.profiles.get(id(r));if(!p||usable&&p.consent_status!=="granted")fail("NOT_FOUND",404);return p;}
  async putResident(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),r=id(x.resident_id),old=a.store.profiles.get(r);
    if(ver(x.expected_version)!==(old?.profile_version??0))fail("VERSION_CONFLICT",409);
    const rawConstraints=x.approved_care_constraints??old?.approved_care_constraints??[];
    if(!Array.isArray(rawConstraints)||rawConstraints.length>30)fail("INVALID_LIST");
    const approved_care_constraints=rawConstraints.map(c=>({category:id(obj(c).category),prohibited_value:str(c.prohibited_value),applies_to:categoryList(c.applies_to),source_reference:str(c.source_reference)}));
    const p={approved_care_constraints,resident_id:r,tenant_id:a.t,facility_id:a.f,display_name:str(x.display_name,100),room_number:str(x.room_number,30),preferred_name:str(x.preferred_name,100),consent_status:one(x.consent_status,["granted","pending","withdrawn"]),profile_version:(old?.profile_version??0)+1,updated_at:this.#now(),updated_by:a.actor};
    a.store.profiles.set(r,p);
    if(old?.consent_status==="granted"&&p.consent_status!=="granted")for(const [k,v] of a.store.preferences)if(v.resident_id===r)a.store.preferences.set(k,{...v,verification_status:"withdrawn",updated_at:p.updated_at});
    await this.#audit(a,"resident_updated",r);return clone(p);
  }
  async deleteResident(req,r,expected){
    const a=await this.#authorize(req,true),p=this.#profile(a,r,false);
    if(ver(expected)!==p.profile_version)fail("VERSION_CONFLICT",409);
    if([...a.store.logs.values()].some(x=>x.resident_id===r))fail("RETENTION_REVIEW_REQUIRED",409);
    a.store.profiles.delete(r);for(const [k,v] of a.store.preferences)if(v.resident_id===r)a.store.preferences.delete(k);await this.#audit(a,"resident_deleted",r);
  }
  async residents(req){const a=await this.#authorize(req);await this.#audit(a,"resident_list","scope");return clone([...a.store.profiles.values()].filter(p=>p.consent_status==="granted").map(p=>({resident_id:p.resident_id,display_name:p.display_name,room_number:p.room_number,profile_version:p.profile_version})));}
  async resident(req,r){const a=await this.#authorize(req),p=this.#profile(a,r),now=this.#now();await this.#audit(a,"resident_read",r);return clone({profile:p,preferences:[...a.store.preferences.values()].filter(v=>v.resident_id===r&&v.verification_status==="verified"&&activeAt(v,now)),interactions:[...a.store.logs.values()].filter(v=>v.resident_id===r).map(({signature,promotion_priority,...v})=>v)});}
  async putPreference(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),p=this.#profile(a,x.resident_id),k=id(x.preference_id),old=a.store.preferences.get(k);
    if(old&&old.resident_id!==p.resident_id)fail("NOT_FOUND",404);
    if(ver(x.expected_version)!==p.profile_version)fail("VERSION_CONFLICT",409);
    const effective_from=instant(x.effective_from),expires_at=x.expires_at===null?null:instant(x.expires_at);
    if(expires_at&&expires_at<=effective_from)fail("INVALID_TIME");
    const source_type=one(x.source_type,["resident","staff_observation","unconfirmed"]),verification_status=one(x.verification_status,["pending","verified","withdrawn"]);
    if(source_type==="unconfirmed"&&verification_status==="verified")fail("UNVERIFIED_SOURCE");
    const v={preference_id:k,resident_id:p.resident_id,tenant_id:a.t,facility_id:a.f,category:id(x.category),applies_to:categoryList(x.applies_to),value:str(x.value),source_type,source_reference:str(x.source_reference),verification_status,effective_from,expires_at,approved_by:verification_status==="verified"?a.actor:null,updated_at:this.#now()};
    a.store.preferences.set(k,v);a.store.profiles.set(p.resident_id,{...p,profile_version:p.profile_version+1,updated_at:this.#now(),updated_by:a.actor});await this.#audit(a,"preference_updated",k);return clone(v);
  }
  async putSop(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),sid=id(x.sop_id),h=a.store.sops.get(sid)??[],old=h.at(-1);
    if(ver(x.expected_version)!==(old?.version??0)||old&&["DRAFT","IN_REVIEW"].includes(old.approval_status))fail("VERSION_CONFLICT",409);
    const steps=list(x.steps),required_checks=list(x.required_checks),allowed_roles=list(x.allowed_roles).map(r=>one(r,roles));
    if(!steps.length||!required_checks.length||!allowed_roles.length||new Set(required_checks).size!==required_checks.length)fail("INVALID_SOP");
    const pv=x.prohibited_values??[];if(!Array.isArray(pv)||pv.length>30)fail("INVALID_LIST");
    const s={sop_id:sid,tenant_id:a.t,facility_id:a.f,category:one(x.category,categories),title:str(x.title,100),description:str(x.description),trigger_conditions:list(x.trigger_conditions),steps,required_checks,allowed_roles,escalation_conditions:list(x.escalation_conditions),prohibited_actions:list(x.prohibited_actions),prohibited_values:pv.map(v=>({category:id(obj(v).category),value:str(v.value)})),completion_requirements:list(x.completion_requirements),version:(old?.version??0)+1,revision:1,approval_status:"DRAFT",approved_by:null,effective_from:instant(x.effective_from),source_reference:str(x.source_reference)};
    a.store.sops.set(sid,[...h,s]);await this.#audit(a,"sop_drafted",sid);return clone(s);
  }
  async transitionSop(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),sid=id(x.sop_id),h=a.store.sops.get(sid)??[],s=h.at(-1);
    if(!s)fail("NOT_FOUND",404);
    if(ver(x.version,1)!==s.version||ver(x.expected_revision,1)!==s.revision)fail("VERSION_CONFLICT",409);
    const next=one(x.status,["IN_REVIEW","APPROVED","ARCHIVED"]);
    if(!({DRAFT:["IN_REVIEW","ARCHIVED"],IN_REVIEW:["APPROVED","ARCHIVED"],APPROVED:["ARCHIVED"],ARCHIVED:[]}[s.approval_status]).includes(next))fail("INVALID_TRANSITION",409);
    if(next==="APPROVED"&&s.effective_from>this.#now())fail("FUTURE_APPROVAL_UNSUPPORTED");
    const updated={...s,revision:s.revision+1,approval_status:next,approved_by:next==="APPROVED"?a.actor:s.approved_by};
    const retained=h.slice(0,-1).map(v=>next==="APPROVED"&&v.approval_status==="APPROVED"?{...v,approval_status:"ARCHIVED",archived_at:this.#now()}:v);
    a.store.sops.set(sid,[...retained,updated]);await this.#audit(a,"sop_"+next.toLowerCase(),sid);return clone(updated);
  }
  async sopHistory(req,sid){const a=await this.#authorize(req,true);const history=a.store.sops.get(id(sid))??[];await this.#audit(a,"sop_history_read",sid);return clone(history);}
  #guide(a,r,c,choice=null){
    const p=this.#profile(a,r);
    if(choice!==null)choice={category:id(obj(choice).category),value:str(choice.value)};
    return resolveGuide({profile:p,preferences:[...a.store.preferences.values()],sops:[...a.store.sops.values()].flat(),category:c,actorRoles:a.roles,asOf:this.#now(),currentChoice:choice});
  }
  async guide(req,r,c,choice=null){const a=await this.#authorize(req),g=this.#guide(a,r,c,choice);await this.#audit(a,"guide_read",r);return clone(g);}
  async record(req,raw){
    const a=await this.#authorize(req),x=obj(raw),iid=id(x.interaction_id),r=id(x.resident_id),category=one(x.interaction_type,categories);this.#profile(a,r);
    if(typeof x.followup_required!=="boolean")fail("INVALID_FOLLOWUP");
    if(x.human_confirmed!==true)fail("HUMAN_CONFIRMATION_REQUIRED",409);
    const checks=list(x.confirmed_checks),summary=str(x.action_summary,1000),status=one(x.status,["RECORDED","FOLLOWUP"]);
    if((status==="FOLLOWUP")!==x.followup_required)fail("INVALID_FOLLOWUP");
    const choice=x.current_choice==null?null:{category:id(obj(x.current_choice).category),value:str(x.current_choice.value)};
    const expected=ver(x.resident_context_version,1),sv=x.sop_version===null?null:ver(x.sop_version,1),sid=x.sop_id===null?null:id(x.sop_id);
    const guideToken=str(x.guide_token,16000);
    const signature=JSON.stringify([r,category,expected,sid,sv,summary,status,checks,choice,guideToken]),old=a.store.logs.get(iid);
    if(old){if(old.signature!==signature||old.actor_id!==a.actor)fail("IDEMPOTENCY_CONFLICT",409);const {signature:_,promotion_priority,...v}=old;await this.#audit(a,"interaction_replayed",iid);return clone(v);}
    const g=this.#guide(a,r,category,choice);
    if(g.resident_context_version!==expected||g.sop_version!==sv||g.applicable_sop!==sid||g.guide_token!==guideToken)fail("STALE_GUIDE",409);
    if(g.blocked&&!x.followup_required)fail("REVIEW_REQUIRED",409);
    if(!g.blocked&&!g.required_confirmations.every(v=>checks.includes(v)))fail("CHECKS_REQUIRED",409);
    if(!checks.every(v=>g.required_confirmations.includes(v)))fail("UNKNOWN_CHECK");
    // Record the actual guide evidence and checks; no model can change Case status.
    const log={interaction_id:iid,tenant_id:a.t,facility_id:a.f,resident_id:r,actor_id:a.actor,interaction_type:category,sop_id:sid,sop_version:sv,resident_context_version:expected,action_summary:summary,status,followup_required:x.followup_required,related_case_id:null,version:1,created_at:this.#now(),confirmed_checks:checks,guide_snapshot:clone(g)};
    a.store.logs.set(iid,{...log,signature});await this.#audit(a,"interaction_recorded",iid);return clone(log);
  }
  async promote(req,iid,expected,priority){
    const a=await this.#authorize(req),key=id(iid),log=a.store.logs.get(key);if(!log)fail("NOT_FOUND",404);this.#profile(a,log.resident_id);
    if(!a.roles.some(r=>r==="supervisor"||r==="dispatcher"))fail("FORBIDDEN",403);
    if(this.#snapshots)fail("DURABLE_CASE_INTEGRATION_REQUIRED",409);
    if(log.review?.decision==="NO_FURTHER_ACTION")fail("VERSION_CONFLICT",409);
    one(priority,["critical","high","normal","low"]);ver(expected,1);
    if(log.related_case_id){if(log.promotion_priority!==priority||![log.version,log.version-1].includes(expected))fail("VERSION_CONFLICT",409);return {case_id:log.related_case_id,version:log.version};}
    if(log.version!==expected||!log.followup_required)fail("VERSION_CONFLICT",409);
    // Only a trusted server-side binding may certify an exclusive CareOps tenant.
    const b=await this.#binding(a.t,a.f);if(!this.#case||!b||b.facility_exclusive!==true||b.tenant_id!==a.t||b.facility_id!==a.f)fail("FACILITY_CASE_SCOPE_UNVERIFIED",409);
    const lock=JSON.stringify([a.key,key]);if(this.#pending.has(lock))fail("PROMOTION_IN_PROGRESS",409);
    this.#pending.add(lock);
    try{
      const latest=a.store.logs.get(key);
      if(latest?.related_case_id){if(latest.promotion_priority!==priority)fail("IDEMPOTENCY_CONFLICT",409);return {case_id:latest.related_case_id,version:latest.version};}
      const checked=await this.#authorize(req);if(checked.actor!==a.actor||!checked.roles.some(r=>r==="supervisor"||r==="dispatcher"))fail("FORBIDDEN",403);
      const current=checked.store.logs.get(key);if(!current||current.version!==log.version||current.review?.decision==="NO_FURTHER_ACTION")fail("VERSION_CONFLICT",409);
      this.#profile(a,log.resident_id);await this.#audit(a,"promotion_requested",key);
      const signalId="pc:"+key,subjectId="interaction:"+key;
      const opened=await this.#case.openFromSignal({id:signalId,tenantId:a.t,sourceAdapter:"personalized-care",subjectId,type:"manual",priority},signalId);
      const c=opened.aggregate;if(c.tenantId!==a.t||c.sourceSignalId!==signalId||c.priority!==priority||c.subjectId!==subjectId||c.sourceAdapter!=="personalized-care")fail("CASE_LINK_MISMATCH",409);
      const updated={...log,related_case_id:c.id,promotion_priority:priority,version:log.version+1};
      a.store.logs.set(key,updated);await this.#audit(a,"interaction_promoted",key);return {case_id:c.id,version:updated.version};
    }finally{this.#pending.delete(lock);}
  }
  #lessonSource(a,lesson){
    return lessonEvidence({sops:[...a.store.sops.values()].flat(),lesson,tenantId:a.t,facilityId:a.f,roles:a.roles,asOf:this.#now()});
  }
  async draftLesson(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),lid=id(x.lesson_id);
    if(Object.keys(x).sort().join(",")!=="category,correct_option_id,evidence,lesson_id,objective,options,pii_reviewed,rationale,reflection_prompt,scenario,title"||x.pii_reviewed!==true)fail("INVALID_LESSON");
    if(a.store.lessons.has(lid))fail("VERSION_CONFLICT",409);
    if(a.store.lessons.size>=200)fail("ACADEMY_LIMIT",413);
    const category=one(x.category,categories.filter(c=>!["emergency","irregular"].includes(c)));
    const e=obj(x.evidence),sid=id(e.sop_id),version=ver(e.version,1),revision=ver(e.revision,1),field=one(e.field,educationFields),index=ver(e.index);
    if(Object.keys(e).sort().join(",")!=="field,index,revision,sop_id,version")fail("INVALID_LESSON_EVIDENCE");
    const source=(a.store.sops.get(sid)??[]).find(s=>s.version===version&&s.revision===revision);
    const quote=source?.[field]?.[index];
    if(typeof quote!=="string"||!quote)fail("LESSON_SOURCE_UNAVAILABLE",409);
    if(!Array.isArray(x.options)||x.options.length<2||x.options.length>4)fail("INVALID_LESSON_OPTIONS");
    const options=x.options.map(o=>{obj(o);if(Object.keys(o).sort().join(",")!=="option_id,text")fail("INVALID_LESSON_OPTIONS");return {option_id:id(o.option_id),text:str(o.text,250)};});
    if(new Set(options.map(o=>o.option_id)).size!==options.length||new Set(options.map(o=>o.text)).size!==options.length||!options.some(o=>o.option_id===x.correct_option_id))fail("INVALID_LESSON_OPTIONS");
    const lesson={lesson_id:lid,tenant_id:a.t,facility_id:a.f,category,title:str(x.title,100),objective:str(x.objective,250),scenario:str(x.scenario,1000),options,correct_option_id:x.correct_option_id,rationale:str(x.rationale,500),reflection_prompt:str(x.reflection_prompt,250),evidence:{sop_id:sid,version,revision,field,index,quote,source_reference:source.source_reference},status:"DRAFT",revision:1,author_id:a.actor,approved_by:null,created_at:this.#now(),training_only:true};
    if(!this.#lessonSource(a,lesson))fail("LESSON_SOURCE_UNAVAILABLE",409);
    a.store.lessons.set(lid,lesson);await this.#audit(a,"lesson_drafted",lid);return clone(lesson);
  }
  async transitionLesson(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),lid=id(x.lesson_id),old=a.store.lessons.get(lid);
    if(!old)fail("NOT_FOUND",404);
    const next=one(x.status,["APPROVED","ARCHIVED"]);
    if(Object.keys(x).sort().join(",")!=="expected_revision,human_confirmed,lesson_id,status"||x.human_confirmed!==true)fail("HUMAN_CONFIRMATION_REQUIRED");
    if(ver(x.expected_revision,1)!==old.revision)fail("VERSION_CONFLICT",409);
    if(old.status==="ARCHIVED"||next==="APPROVED"&&old.status!=="DRAFT")fail("INVALID_TRANSITION",409);
    if(next==="APPROVED"){if(old.author_id===a.actor)fail("INDEPENDENT_REVIEW_REQUIRED",403);if(!this.#lessonSource(a,old))fail("LESSON_SOURCE_UNAVAILABLE",409);}
    const lesson={...old,status:next,revision:old.revision+1,approved_by:next==="APPROVED"?a.actor:old.approved_by,updated_at:this.#now()};
    a.store.lessons.set(lid,lesson);await this.#audit(a,"lesson_"+next.toLowerCase(),lid);return clone(lesson);
  }
  async lessonAdmin(req){
    const a=await this.#authorize(req,true),items=[...a.store.lessons.values()].map(l=>({...l,source_current:!!this.#lessonSource(a,l)}));
    await this.#audit(a,"lesson_admin_read","scope");return clone(items);
  }
  async academy(req){
    const a=await this.#authorize(req),now=this.#now(),items=[...a.store.lessons.values()].filter(l=>l.status==="APPROVED"&&this.#lessonSource(a,l)).map(l=>learnerView(l,a.store.learning.get(JSON.stringify([a.actor,l.lesson_id])),now)).sort((x,y)=>Number(y.due)-Number(x.due)||cmp(x.lesson_id,y.lesson_id));
    await this.#audit(a,"academy_read","scope");return clone({lessons:items,due_count:items.filter(l=>l.due).length,training_only:true,certification:false});
  }
  async practiceLesson(req,raw){
    const a=await this.#authorize(req),x=obj(raw),lid=id(x.lesson_id),attempt=id(x.attempt_id),choice=id(x.option_id);
    if(Object.keys(x).sort().join(",")!=="attempt_id,expected_progress_version,expected_revision,lesson_id,option_id")fail("INVALID_LEARNING_REQUEST");
    const l=a.store.lessons.get(lid),now=this.#now();
    if(!l||l.status!=="APPROVED")fail("NOT_FOUND",404);
    const evidence=this.#lessonSource(a,l);if(!evidence)fail("LESSON_SOURCE_UNAVAILABLE",409);
    if(ver(x.expected_revision,1)!==l.revision)fail("VERSION_CONFLICT",409);
    if(!l.options.some(o=>o.option_id===choice))fail("INVALID_LESSON_OPTION");
    const key=JSON.stringify([a.actor,lid]),old=a.store.learning.get(key),pv=ver(x.expected_progress_version);
    if(old?.last_attempt_id===attempt){
      if(old.last_option_id!==choice||pv!==old.version-1)fail("IDEMPOTENCY_CONFLICT",409);
      await this.#audit(a,"lesson_attempt_replayed",lid);return clone(old.feedback);
    }
    if(pv!==(old?.version??0))fail("VERSION_CONFLICT",409);
    if(old&&old.due_at>now)fail("REVIEW_NOT_DUE",409);
    if(!old&&a.store.learning.size>=5000)fail("ACADEMY_LIMIT",413);
    const correct=choice===l.correct_option_id,plan=reviewSchedule({correct,streak:old?.streak??0,asOf:now});
    const feedback={lesson_id:lid,correct,correct_option_id:l.correct_option_id,rationale:l.rationale,reflection_prompt:l.reflection_prompt,evidence,due_at:plan.due_at,review_interval_days:plan.days,progress_version:pv+1,training_only:true,certification:false};
    a.store.learning.set(key,{progress_key:key,actor_id:a.actor,lesson_id:lid,tenant_id:a.t,facility_id:a.f,version:pv+1,practice_count:(old?.practice_count??0)+1,streak:plan.streak,due_at:plan.due_at,last_attempt_id:attempt,last_option_id:choice,feedback});
    await this.#audit(a,"lesson_practiced",lid);return clone(feedback);
  }
  async searchKnowledge(req,raw){
    const a=await this.#authorize(req),x=obj(raw);
    if(Object.keys(x).sort().join(",")!=="category,query")fail("INVALID_KNOWLEDGE_REQUEST");
    const category=one(x.category,categories),query=str(x.query,120);
    const result=retrieveSopEvidence({query,category,sops:[...a.store.sops.values()].flat(),tenantId:a.t,facilityId:a.f,roles:a.roles,asOf:this.#now()});
    await this.#audit(a,"knowledge_search",category);
    return clone(result);
  }
  async knowledgeCoverage(req){
    const a=await this.#authorize(req,true);
    const result=knowledgeCoverage({categories,sops:[...a.store.sops.values()].flat(),tenantId:a.t,facilityId:a.f,roles:a.roles,asOf:this.#now()});
    await this.#audit(a,"knowledge_coverage_read","scope");
    return clone(result);
  }
  async operator(req){
    const a=await this.#authorize(req);
    return {roles:[...a.roles].sort(cmp),can_review:a.roles.includes("supervisor"),can_attempt_promotion:!this.#snapshots&&!!this.#case&&a.roles.some(r=>r==="supervisor"||r==="dispatcher"),synthetic_persistence:!!this.#snapshots};
  }
  async followups(req){
    const a=await this.#authorize(req);
    const items=[...a.store.logs.values()].filter(x=>x.followup_required&&a.store.profiles.get(x.resident_id)?.consent_status==="granted"&&x.review?.decision!=="NO_FURTHER_ACTION").sort((x,y)=>cmp(x.created_at,y.created_at)||cmp(x.interaction_id,y.interaction_id));
    await this.#audit(a,"followups_read","scope");
    return clone(items.map(x=>({interaction_id:x.interaction_id,resident_id:x.resident_id,interaction_type:x.interaction_type,created_at:x.created_at,version:x.version,case_linked:!!x.related_case_id,blocked:x.guide_snapshot.blocked,review:x.review??null,requires_review:!x.review||x.guide_snapshot.blocked,action_summary:x.action_summary})));
  }
  async reviewFollowup(req,iid,raw){
    const a=await this.#authorize(req,true),x=obj(raw),key=id(iid),log=a.store.logs.get(key);
    if(!log||!log.followup_required)fail("NOT_FOUND",404);
    if(this.#pending.has(JSON.stringify([a.key,key])))fail("PROMOTION_IN_PROGRESS",409);
    this.#profile(a,log.resident_id);
    if(ver(x.expected_version,1)!==log.version)fail("VERSION_CONFLICT",409);
    if(log.related_case_id||log.review?.decision==="NO_FURTHER_ACTION")fail("VERSION_CONFLICT",409);
    if(x.human_confirmed!==true)fail("HUMAN_CONFIRMATION_REQUIRED",409);
    const decision=one(x.decision,["CONTINUE_FOLLOWUP","REQUEST_CASE","NO_FURTHER_ACTION"]);
    if(decision==="NO_FURTHER_ACTION"&&log.guide_snapshot.blocked)fail("REVIEW_REQUIRED",409);
    const review={decision,reason:str(x.reason,500),reviewed_by:a.actor,reviewed_at:this.#now()};
    const updated={...log,review,review_history:[...(log.review_history??[]),review],version:log.version+1};
    a.store.logs.set(key,updated);await this.#audit(a,"followup_reviewed",key);
    return clone({interaction_id:key,version:updated.version,review});
  }
  async audit(req){const a=await this.#authorize(req,true);await this.#audit(a,"audit_read","scope");return clone(a.store.audit);}
}

export function validateClassification(raw){const x=obj(raw);if(Object.keys(x).sort().join(",")!=="category,source_reference")fail("INVALID_AI_OUTPUT");return {category:one(x.category,categories),source_reference:str(x.source_reference,200)};}

export function offlineCategory(text){if(typeof text!=="string")return null;return new Map([["朝の声かけ","greeting"],["設備の相談","equipment"],["申し送り","handover"]]).get(text)??null;}

export async function seedDemo(service,req){
  const start="2026-01-01T00:00:00.000Z";
  for(const [r,name,room,items] of [["a","Aさん","101",[["wake_time","朝6時頃"],["conversation","会話を楽しみたい"],["independence","自分でできることは自分で行いたい"]]],["b","Bさん","102",[["wake_time","朝8時頃"],["environment","静かな環境"],["visit_contact","訪室前に連絡"]]],["c","Cさん","103",[["wake_time","本人のペース"],["communication","筆談での説明"]]]]){
    await service.putResident(req,{resident_id:r,expected_version:0,display_name:name,room_number:room,preferred_name:name,consent_status:"granted"});let v=1;
    for(const [category,value] of items)await service.putPreference(req,{resident_id:r,preference_id:r+"-"+category,expected_version:v++,category,applies_to:["greeting"],value,source_type:"resident",source_reference:"synthetic-"+r+"-"+category,verification_status:"verified",effective_from:start,expires_at:null});
  }
  await service.putSop(req,{sop_id:"morning",expected_version:0,category:"greeting",title:"朝の声かけ",description:"架空施設の共通手順",trigger_conditions:["朝の声かけ"],steps:["本人の都合と希望を確認する。","施設の承認済み手順に沿って対応する。","必要な情報を記録・共有する。"],required_checks:["本人の現在の希望を確認"],allowed_roles:["responder","supervisor","dispatcher"],escalation_conditions:["希望と安全基準が矛盾する場合は責任者へ相談"],prohibited_actions:["希望の無視","無断訪室"],prohibited_values:[],completion_requirements:["必要時のみ記録"],effective_from:start,source_reference:"synthetic-sop-morning-v1"});
  await service.transitionSop(req,{sop_id:"morning",version:1,expected_revision:1,status:"IN_REVIEW"});await service.transitionSop(req,{sop_id:"morning",version:1,expected_revision:2,status:"APPROVED"});
}

/** Synthetic fixture only: requires independently authenticated supervisor accounts. */
export async function seedAcademyDemo(service,author,reviewer){
 await service.draftLesson(author,{lesson_id:"morning-choice-1",category:"greeting",title:"本人の希望を尊重する",objective:"登録済みの希望と現在の意思を区別する",scenario:"架空の入居者が、普段の起床時刻とは違う時間まで休みたいと話しました。最初に何を確認しますか？",options:[{option_id:"a",text:"登録された時刻だけで対応を決める"},{option_id:"b",text:"現在の本人の希望を確認し、施設の承認済み手順を確認する"},{option_id:"c",text:"必要な確認を自動的に取り消す"}],correct_option_id:"b",rationale:"本人が今伝えた希望を確認することが第一歩です。安全基準との矛盾や不明点は責任者に相談します。",reflection_prompt:"自分の施設では、本人の希望が変わったとき誰に確認しますか？",evidence:{sop_id:"morning",version:1,revision:3,field:"steps",index:0},pii_reviewed:true});
 await service.transitionLesson(reviewer,{lesson_id:"morning-choice-1",expected_revision:1,status:"APPROVED",human_confirmed:true});
}
