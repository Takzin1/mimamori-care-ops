// Isolated in-memory P0 slice. No production activation.

export const categories=["hospitality","greeting","request","life_consultation","room_visit","outing","family","equipment","complaint","report","handover","checkin","irregular","emergency"];

const roles=["supervisor","dispatcher","responder"];

const clone=x=>JSON.parse(JSON.stringify(x));

function fail(code,status=400){throw Object.assign(new Error(code),{status});}

function id(x){if(typeof x!=="string"||!/^[A-Za-z0-9._:-]{1,64}$/.test(x))fail("INVALID_ID");return x;}

function str(x,max=500){if(typeof x!=="string"||!x.trim()||x.length>max)fail("INVALID_TEXT");return x.trim();}

function list(x){if(!Array.isArray(x)||x.length>30)fail("INVALID_LIST");return x.map(v=>str(v));}

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
  const candidates=sops.filter(s=>same(s)&&s.category===category&&s.approval_status==="APPROVED"&&s.effective_from<=asOf&&s.allowed_roles.some(r=>actorRoles.includes(r))).sort((a,b)=>cmp(a.sop_id,b.sop_id)||b.version-a.version);
  const active=preferences.filter(p=>same(p)&&p.resident_id===profile.resident_id&&activeAt(p,asOf)).sort((a,b)=>cmp(a.preference_id,b.preference_id));
  const wishes=active.filter(p=>p.verification_status==="verified"&&p.source_type==="resident");
  const observations=active.filter(p=>p.verification_status==="verified"&&p.source_type==="staff_observation");
  const sop=candidates.length===1?candidates[0]:null, conflicts=[], unresolved_questions=[];
  for(const p of wishes){
    if(wishes.some(q=>q.category===p.category&&q.value!==p.value)||currentChoice?.category===p.category&&currentChoice.value!==p.value)conflicts.push({category:p.category,reason:"WISH_CONFLICT"});
  }
  for(const p of [...wishes,...(currentChoice?[currentChoice]:[])])if(candidates.some(s=>s.prohibited_values.some(v=>v.category===p.category&&v.value===p.value)))conflicts.push({category:p.category,reason:"SOP_CONFLICT"});
  for(const p of active.filter(p=>p.verification_status==="pending"))unresolved_questions.push("未確認の情報："+p.category);
  if(!wishes.length)unresolved_questions.push("本人の現在の希望を確認してください。");
  if(!sop)unresolved_questions.push(candidates.length?"複数の手順が該当。責任者へ確認。":"承認済み手順なし。責任者へ確認。");
  const blocked=!sop||conflicts.length>0||["emergency","irregular"].includes(category);
  return {applicable_sop:sop?.sop_id??null,sop_version:sop?.version??null,resident_context_version:profile.profile_version,standard_steps:sop?.steps??[],personalized_considerations:wishes.filter(p=>!conflicts.some(c=>c.category===p.category)).map(p=>({category:p.category,value:p.value,source_reference:p.source_reference})),observed_facts:observations.map(p=>({category:p.category,value:p.value,source_reference:p.source_reference})),required_confirmations:sop?.required_checks??[],escalation_conditions:sop?.escalation_conditions??[],prohibited_actions:sop?.prohibited_actions??[],completion_requirements:sop?.completion_requirements??[],unresolved_questions,evidence_references:[...(sop?[sop.source_reference]:[]),...wishes.map(p=>p.source_reference),...observations.map(p=>p.source_reference)],conflicts,human_review_required:true,blocked};
}

export class PersonalizedCareService {
  #auth;#members;#grant;#case;#binding;#clock;#scopes=new Map();#pending=new Set();
  constructor({authenticator,memberships,facilityGrant,caseService=null,caseBinding=async()=>null,clock=()=>new Date().toISOString()}){this.#auth=authenticator;this.#members=memberships;this.#grant=facilityGrant;this.#case=caseService;this.#binding=caseBinding;this.#clock=clock;}
  #now(){return instant(this.#clock());}
  async #authorize(req,admin=false){
    const t=id(req.tenant_id),f=id(req.facility_id);
    if(typeof req.accessToken!=="string"||!req.accessToken||req.accessToken.length>8192)fail("AUTH_REQUIRED",401);
    let p;try{p=await this.#auth.authenticate(req.accessToken);}catch{fail("AUTH_REQUIRED",401);}
    const m=await this.#members.findByPrincipal(t,p.principalId),g=await this.#grant(t,f,p.principalId);
    if(!m?.active||m.tenantId!==t||m.principalId!==p.principalId||!g?.active||g.tenant_id!==t||g.facility_id!==f||g.principal_id!==p.principalId||!Array.isArray(g.roles))fail("NOT_FOUND",404);
    const r=m.roles.filter(x=>roles.includes(x)&&g.roles.includes(x));
    if(!r.length||admin&&!r.includes("supervisor"))fail("FORBIDDEN",403);
    const key=JSON.stringify([t,f]);
    if(!this.#scopes.has(key))this.#scopes.set(key,{profiles:new Map(),preferences:new Map(),sops:new Map(),logs:new Map(),audit:[]});
    return {t,f,key,actor:id(m.actorId),roles:r,store:this.#scopes.get(key)};
  }
  #audit(a,action,ref){a.store.audit.push({action,ref,actor_id:a.actor,at:this.#now()});}
  #profile(a,r,usable=true){const p=a.store.profiles.get(id(r));if(!p||usable&&p.consent_status!=="granted")fail("NOT_FOUND",404);return p;}
  async putResident(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),r=id(x.resident_id),old=a.store.profiles.get(r);
    if(ver(x.expected_version)!==(old?.profile_version??0))fail("VERSION_CONFLICT",409);
    const p={resident_id:r,tenant_id:a.t,facility_id:a.f,display_name:str(x.display_name,100),room_number:str(x.room_number,30),preferred_name:str(x.preferred_name,100),consent_status:one(x.consent_status,["granted","pending","withdrawn"]),profile_version:(old?.profile_version??0)+1,updated_at:this.#now(),updated_by:a.actor};
    a.store.profiles.set(r,p);this.#audit(a,"resident_updated",r);return clone(p);
  }
  async deleteResident(req,r,expected){
    const a=await this.#authorize(req,true),p=this.#profile(a,r,false);
    if(ver(expected)!==p.profile_version)fail("VERSION_CONFLICT",409);
    if([...a.store.logs.values()].some(x=>x.resident_id===r))fail("RETENTION_REVIEW_REQUIRED",409);
    a.store.profiles.delete(r);for(const [k,v] of a.store.preferences)if(v.resident_id===r)a.store.preferences.delete(k);this.#audit(a,"resident_deleted",r);
  }
  async residents(req){const a=await this.#authorize(req);this.#audit(a,"resident_list","scope");return clone([...a.store.profiles.values()].filter(p=>p.consent_status==="granted").map(p=>({resident_id:p.resident_id,display_name:p.display_name,room_number:p.room_number,profile_version:p.profile_version})));}
  async resident(req,r){const a=await this.#authorize(req),p=this.#profile(a,r),now=this.#now();this.#audit(a,"resident_read",r);return clone({profile:p,preferences:[...a.store.preferences.values()].filter(v=>v.resident_id===r&&v.verification_status==="verified"&&activeAt(v,now)),interactions:[...a.store.logs.values()].filter(v=>v.resident_id===r).map(({signature,promotion_priority,...v})=>v)});}
  async putPreference(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),p=this.#profile(a,x.resident_id),k=id(x.preference_id),old=a.store.preferences.get(k);
    if(old&&old.resident_id!==p.resident_id)fail("NOT_FOUND",404);
    if(ver(x.expected_version)!==p.profile_version)fail("VERSION_CONFLICT",409);
    const effective_from=instant(x.effective_from),expires_at=x.expires_at===null?null:instant(x.expires_at);
    if(expires_at&&expires_at<=effective_from)fail("INVALID_TIME");
    const source_type=one(x.source_type,["resident","staff_observation","unconfirmed"]),verification_status=one(x.verification_status,["pending","verified","withdrawn"]);
    if(source_type==="unconfirmed"&&verification_status==="verified")fail("UNVERIFIED_SOURCE");
    const v={preference_id:k,resident_id:p.resident_id,tenant_id:a.t,facility_id:a.f,category:id(x.category),value:str(x.value),source_type,source_reference:str(x.source_reference),verification_status,effective_from,expires_at,approved_by:verification_status==="verified"?a.actor:null,updated_at:this.#now()};
    a.store.preferences.set(k,v);a.store.profiles.set(p.resident_id,{...p,profile_version:p.profile_version+1,updated_at:this.#now(),updated_by:a.actor});this.#audit(a,"preference_updated",k);return clone(v);
  }
  async putSop(req,raw){
    const a=await this.#authorize(req,true),x=obj(raw),sid=id(x.sop_id),h=a.store.sops.get(sid)??[],old=h.at(-1);
    if(ver(x.expected_version)!==(old?.version??0)||old&&["DRAFT","IN_REVIEW"].includes(old.approval_status))fail("VERSION_CONFLICT",409);
    const steps=list(x.steps),required_checks=list(x.required_checks),allowed_roles=list(x.allowed_roles).map(r=>one(r,roles));
    if(!steps.length||!required_checks.length||!allowed_roles.length||new Set(required_checks).size!==required_checks.length)fail("INVALID_SOP");
    const pv=x.prohibited_values??[];if(!Array.isArray(pv)||pv.length>30)fail("INVALID_LIST");
    const s={sop_id:sid,tenant_id:a.t,facility_id:a.f,category:one(x.category,categories),title:str(x.title,100),description:str(x.description),trigger_conditions:list(x.trigger_conditions),steps,required_checks,allowed_roles,escalation_conditions:list(x.escalation_conditions),prohibited_actions:list(x.prohibited_actions),prohibited_values:pv.map(v=>({category:id(obj(v).category),value:str(v.value)})),completion_requirements:list(x.completion_requirements),version:(old?.version??0)+1,revision:1,approval_status:"DRAFT",approved_by:null,effective_from:instant(x.effective_from),source_reference:str(x.source_reference)};
    a.store.sops.set(sid,[...h,s]);this.#audit(a,"sop_drafted",sid);return clone(s);
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
    a.store.sops.set(sid,[...retained,updated]);this.#audit(a,"sop_"+next.toLowerCase(),sid);return clone(updated);
  }
  async sopHistory(req,sid){const a=await this.#authorize(req,true);return clone(a.store.sops.get(id(sid))??[]);}
  #guide(a,r,c,choice=null){
    const p=this.#profile(a,r);
    if(choice!==null)choice={category:id(obj(choice).category),value:str(choice.value)};
    return resolveGuide({profile:p,preferences:[...a.store.preferences.values()],sops:[...a.store.sops.values()].flat(),category:c,actorRoles:a.roles,asOf:this.#now(),currentChoice:choice});
  }
  async guide(req,r,c,choice=null){const a=await this.#authorize(req),g=this.#guide(a,r,c,choice);this.#audit(a,"guide_read",r);return clone(g);}
  async record(req,raw){
    const a=await this.#authorize(req),x=obj(raw),iid=id(x.interaction_id),r=id(x.resident_id),category=one(x.interaction_type,categories);this.#profile(a,r);
    if(typeof x.followup_required!=="boolean")fail("INVALID_FOLLOWUP");
    if(x.human_confirmed!==true)fail("HUMAN_CONFIRMATION_REQUIRED",409);
    const checks=list(x.confirmed_checks),summary=str(x.action_summary,1000),status=one(x.status,["RECORDED","FOLLOWUP"]);
    if((status==="FOLLOWUP")!==x.followup_required)fail("INVALID_FOLLOWUP");
    const choice=x.current_choice==null?null:{category:id(obj(x.current_choice).category),value:str(x.current_choice.value)};
    const expected=ver(x.resident_context_version,1),sv=x.sop_version===null?null:ver(x.sop_version,1),sid=x.sop_id===null?null:id(x.sop_id);
    const signature=JSON.stringify([r,category,expected,sid,sv,summary,status,checks,choice]),old=a.store.logs.get(iid);
    if(old){if(old.signature!==signature||old.actor_id!==a.actor)fail("IDEMPOTENCY_CONFLICT",409);const {signature:_,promotion_priority,...v}=old;return clone(v);}
    const g=this.#guide(a,r,category,choice);
    if(g.resident_context_version!==expected||g.sop_version!==sv||g.applicable_sop!==sid)fail("STALE_GUIDE",409);
    if(g.blocked&&!x.followup_required)fail("REVIEW_REQUIRED",409);
    if(!g.blocked&&!g.required_confirmations.every(v=>checks.includes(v)))fail("CHECKS_REQUIRED",409);
    if(!checks.every(v=>g.required_confirmations.includes(v)))fail("UNKNOWN_CHECK");
    // Record the actual guide evidence and checks; no model can change Case status.
    const log={interaction_id:iid,tenant_id:a.t,facility_id:a.f,resident_id:r,actor_id:a.actor,interaction_type:category,sop_id:sid,sop_version:sv,resident_context_version:expected,action_summary:summary,status,followup_required:x.followup_required,related_case_id:null,version:1,created_at:this.#now(),confirmed_checks:checks,guide_snapshot:clone(g)};
    a.store.logs.set(iid,{...log,signature});this.#audit(a,"interaction_recorded",iid);return clone(log);
  }
  async promote(req,iid,expected,priority){
    const a=await this.#authorize(req),key=id(iid),log=a.store.logs.get(key);if(!log)fail("NOT_FOUND",404);this.#profile(a,log.resident_id);
    if(!a.roles.some(r=>r==="supervisor"||r==="dispatcher"))fail("FORBIDDEN",403);
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
      this.#profile(a,log.resident_id);this.#audit(a,"promotion_requested",key);
      const signalId="pc:"+key,subjectId="interaction:"+key;
      const opened=await this.#case.openFromSignal({id:signalId,tenantId:a.t,sourceAdapter:"personalized-care",subjectId,type:"manual",priority},signalId);
      const c=opened.aggregate;if(c.tenantId!==a.t||c.sourceSignalId!==signalId||c.priority!==priority||c.subjectId!==subjectId||c.sourceAdapter!=="personalized-care")fail("CASE_LINK_MISMATCH",409);
      const updated={...log,related_case_id:c.id,promotion_priority:priority,version:log.version+1};
      a.store.logs.set(key,updated);this.#audit(a,"interaction_promoted",key);return {case_id:c.id,version:updated.version};
    }finally{this.#pending.delete(lock);}
  }
  async audit(req){const a=await this.#authorize(req,true);return clone(a.store.audit);}
}

export function validateClassification(raw){const x=obj(raw);if(Object.keys(x).sort().join(",")!=="category,source_reference")fail("INVALID_AI_OUTPUT");return {category:one(x.category,categories),source_reference:str(x.source_reference,200)};}

export function offlineCategory(text){if(typeof text!=="string")return null;return new Map([["朝の声かけ","greeting"],["設備の相談","equipment"],["申し送り","handover"]]).get(text)??null;}

export async function seedDemo(service,req){
  const start="2026-01-01T00:00:00.000Z";
  for(const [r,name,room,items] of [["a","Aさん","101",[["wake_time","朝6時頃"],["conversation","会話を楽しみたい"],["independence","自分でできることは自分で行いたい"]]],["b","Bさん","102",[["wake_time","朝8時頃"],["environment","静かな環境"],["visit_contact","訪室前に連絡"]]],["c","Cさん","103",[["wake_time","本人のペース"],["communication","筆談での説明"]]]]){
    await service.putResident(req,{resident_id:r,expected_version:0,display_name:name,room_number:room,preferred_name:name,consent_status:"granted"});let v=1;
    for(const [category,value] of items)await service.putPreference(req,{resident_id:r,preference_id:r+"-"+category,expected_version:v++,category,value,source_type:"resident",source_reference:"synthetic-"+r+"-"+category,verification_status:"verified",effective_from:start,expires_at:null});
  }
  await service.putSop(req,{sop_id:"morning",expected_version:0,category:"greeting",title:"朝の声かけ",description:"架空施設の共通手順",trigger_conditions:["朝の声かけ"],steps:["本人の都合と希望を確認する。","施設の承認済み手順に沿って対応する。","必要な情報を記録・共有する。"],required_checks:["本人の現在の希望を確認"],allowed_roles:["responder","supervisor","dispatcher"],escalation_conditions:["希望と安全基準が矛盾する場合は責任者へ相談"],prohibited_actions:["希望の無視","無断訪室"],prohibited_values:[],completion_requirements:["必要時のみ記録"],effective_from:start,source_reference:"synthetic-sop-morning-v1"});
  await service.transitionSop(req,{sop_id:"morning",version:1,expected_revision:1,status:"IN_REVIEW"});await service.transitionSop(req,{sop_id:"morning",version:1,expected_revision:2,status:"APPROVED"});
}
