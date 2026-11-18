// Experimental isolated PostgreSQL staging adapter. Never connect the browser or a real resident deployment.
function error(code,status=500){return Object.assign(new Error(code),{status});}
const key=x=>typeof x==="string"&&/^[A-Za-z0-9._:-]{1,128}$/.test(x);
const scopeKey=x=>key(x)&&x.length<=64;
const runtimeRoles=["dispatcher","responder","supervisor"];
function validatedContext(t,f,c){
 if(!scopeKey(t)||!scopeKey(f)||!key(c?.principalId)||!scopeKey(c?.actorId)||c.provider!=="line-staff"||!Array.isArray(c.roles)||!c.roles.length||c.roles.some(r=>!runtimeRoles.includes(r))||new Set(c.roles).size!==c.roles.length||typeof c.lineBinding?.channel_id!=="string"||!/^\d{1,20}$/.test(c.lineBinding.channel_id)||typeof c.lineBinding?.line_subject!=="string"||!/^U[0-9a-f]{32}$/i.test(c.lineBinding.line_subject))throw error("SNAPSHOT_ACCESS_DENIED",403);
 return [t,f,c.principalId,c.actorId,c.lineBinding.channel_id,c.lineBinding.line_subject,[...c.roles].sort()];
}
function version(x){const n=typeof x==="string"&&/^[0-9]+$/.test(x)?Number(x):x;if(!Number.isSafeInteger(n)||n<0)throw error("SNAPSHOT_CORRUPT");return n;}
function validatePayload(payload,actor){
 if(typeof payload!=="string"||payload.length>8*1024*1024)throw error("SNAPSHOT_LIMIT",413);
 let v;try{v=JSON.parse(payload);}catch{throw error("SNAPSHOT_CORRUPT");}
 const event=v?.audit?.at(-1);
 if(v?.format!==1||!Array.isArray(v.audit)||!event||event.actor_id!==actor||!key(event.action)||typeof event.ref!=="string"||event.ref.length>128||typeof event.at!=="string"||!Number.isFinite(Date.parse(event.at)))throw error("SNAPSHOT_CORRUPT");
 return {count:v.audit.length,event};
}
export class PostgresSnapshotRepository{
 #pool;
 constructor({pool}){if(typeof pool?.connect!=="function")throw error("STAGING_POOL_REQUIRED");this.#pool=pool;}
 async #transaction(t,f,c,work){
  const p=validatedContext(t,f,c),db=await this.#pool.connect();let discard=false,started=false;
  try{
   await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE");started=true;
   await db.query("SET LOCAL ROLE pc_snapshot_runtime");
   await db.query("SET LOCAL statement_timeout = '5000ms'");
   await db.query("SET LOCAL lock_timeout = '2000ms'");
   await db.query("SELECT set_config('pc.tenant',$1,true),set_config('pc.facility',$2,true),set_config('pc.principal',$3,true)",p.slice(0,3));
   const auth=await db.query("SELECT m.actor_id, ARRAY(SELECT DISTINCT r FROM unnest(m.roles) AS role(r) WHERE r=ANY(g.roles) AND r=ANY(ARRAY['dispatcher','responder','supervisor']::text[]) ORDER BY r) AS roles FROM public.care_tenant_memberships m JOIN personalized_care.facility_membership g ON g.tenant_id=m.tenant_id AND g.principal_id=m.principal_id JOIN personalized_care.line_staff_binding b ON b.tenant_id=m.tenant_id AND b.principal_id=m.principal_id WHERE m.tenant_id=$1 AND g.facility_id=$2 AND m.principal_id=$3 AND m.actor_id=$4 AND b.channel_id=$5 AND b.line_subject=$6 AND m.active AND g.active AND b.active",p.slice(0,6));
   const a=auth.rows?.[0];
   if(auth.rows?.length!==1||a.actor_id!==p[3]||!Array.isArray(a.roles)||JSON.stringify([...a.roles].sort())!==JSON.stringify(p[6]))throw error("SNAPSHOT_ACCESS_DENIED",403);
   const value=await work(db,p);
   await db.query("COMMIT");started=false;return value;
  }catch(e){
   discard=true;if(started){try{await db.query("ROLLBACK");}catch{}}
   if(e?.code==="40001"||e?.code==="40P01"||e?.code==="55P03")throw error("SNAPSHOT_VERSION_CONFLICT",409);
   if(e?.status===403||e?.status===409||e?.status===413)throw e;
   throw error("SNAPSHOT_UNAVAILABLE",503);
  }finally{db.release(discard);}
 }
 async load(t,f,c){
  return this.#transaction(t,f,c,async db=>{
   const r=await db.query("SELECT version,payload::text AS payload FROM personalized_care.scope_snapshot WHERE tenant_id=$1 AND facility_id=$2",[t,f]);
   if(r.rows?.length===0)return null;
   if(r.rows?.length!==1||typeof r.rows[0].payload!=="string")throw error("SNAPSHOT_CORRUPT");
   return {version:version(r.rows[0].version),payload:r.rows[0].payload};
  });
 }
 async save(t,f,expected,payload,c){
  const n=version(expected);if(n>=Number.MAX_SAFE_INTEGER)throw error("SNAPSHOT_LIMIT",413);
  const audit=validatePayload(payload,c?.actorId);
  // Database CAS and exactly one appended audit event, committed together.
  return this.#transaction(t,f,c,async(db,p)=>{
   const result=n===0
    ?await db.query("INSERT INTO personalized_care.scope_snapshot(tenant_id,facility_id,version,payload) SELECT $1,$2,1,$3::jsonb WHERE $4::integer=1 ON CONFLICT DO NOTHING RETURNING version",[t,f,payload,audit.count])
    :await db.query("UPDATE personalized_care.scope_snapshot SET version=version+1,payload=$4::jsonb WHERE tenant_id=$1 AND facility_id=$2 AND version=$3 AND jsonb_array_length(payload->'audit')=$5::integer-1 AND (SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements($4::jsonb->'audit') WITH ORDINALITY AS j(value,ord) WHERE ord<$5::integer)=payload->'audit' RETURNING version",[t,f,n,payload,audit.count]);
   if(result.rows?.length!==1||version(result.rows[0].version)!==n+1)throw error("SNAPSHOT_VERSION_CONFLICT",409);
   await db.query("INSERT INTO personalized_care.scope_audit_journal(tenant_id,facility_id,snapshot_version,actor_id,event) VALUES($1,$2,$3,$4,$5::jsonb)",[t,f,n+1,p[3],JSON.stringify(audit.event)]);
   return n+1;
  });
 }
}
