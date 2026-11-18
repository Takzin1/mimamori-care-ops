function authFailure(){return Object.assign(new Error("AUTHENTICATION_FAILED"),{status:401});}
function validKey(x){return typeof x==="string"&&/^[A-Za-z0-9._:-]{1,64}$/.test(x);}
function validPrincipal(x){return typeof x==="string"&&/^[A-Za-z0-9._:-]{1,128}$/.test(x);}
function validChannel(x){return typeof x==="string"&&/^[0-9]{1,20}$/.test(x);}
function validSubject(x){return typeof x==="string"&&/^U[0-9a-f]{32}$/i.test(x);}
function validToken(x){return typeof x==="string"&&x.length<=8192&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(x);}
async function readClaims(response,decode){
 const max=16384;
 const type=response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
 const length=response.headers.get("content-length");
 if(type!=="application/json"||(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))||!response.body)throw authFailure();
 const reader=response.body.getReader(),buffer=new Uint8Array(max);let size=0,complete=false;
 try{
  while(true){const {done,value}=await reader.read();if(done){complete=true;break;}if(!(value instanceof Uint8Array)||size+value.byteLength>max)throw authFailure();buffer.set(value,size);size+=value.byteLength;}
  const value=JSON.parse(decode(buffer.subarray(0,size)));
  if(!value||typeof value!=="object"||Array.isArray(value))throw authFailure();
  return value;
 }finally{if(!complete){try{await reader.cancel();}catch{}}reader.releaseLock();}
}
export class LineStaffAuthenticator{
 #channel;#directory;#fetch;#clock;#timeout;#decode;
 constructor({channelId,directory,fetchImpl=fetch,clock=()=>Date.now(),timeoutSignal=()=>AbortSignal.timeout(5000),decodeUtf8=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes)}){
  if(!validChannel(channelId)||typeof directory?.findLineBinding!=="function"||typeof fetchImpl!=="function")throw new Error("INVALID_LINE_AUTH_CONFIG");
  this.#channel=channelId;this.#directory=directory;this.#fetch=fetchImpl;this.#clock=clock;this.#timeout=timeoutSignal;this.#decode=decodeUtf8;
 }
 async authenticate(token,scope){
  if(!validToken(token)||!validKey(scope?.tenant_id)||!validKey(scope?.facility_id))throw authFailure();
  try{
   const response=await this.#fetch("https://api.line.me/oauth2/v2.1/verify",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","accept":"application/json"},
    body:"id_token="+encodeURIComponent(token)+"&client_id="+encodeURIComponent(this.#channel),redirect:"error",cache:"no-store",signal:this.#timeout()
   });
   if(!response.ok)throw authFailure();
   const claims=await readClaims(response,this.#decode),now=Math.floor(this.#clock()/1000);
   if(!claims||claims.iss!=="https://access.line.me"||claims.aud!==this.#channel||!validSubject(claims.sub)||!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(now)||claims.exp<=now||claims.iat>now+30||claims.iat>=claims.exp)throw authFailure();
   // Only a trusted, freshly queried directory can map a LINE subject to an enrolled staff principal.
   const binding=await this.#directory.findLineBinding({tenant_id:scope.tenant_id,facility_id:scope.facility_id,channel_id:this.#channel,line_subject:claims.sub});
   if(binding?.active!==true||binding.tenant_id!==scope.tenant_id||binding.facility_id!==scope.facility_id||binding.channel_id!==this.#channel||binding.line_subject!==claims.sub||!validPrincipal(binding.principal_id))throw authFailure();
   if(claims.exp<=Math.floor(this.#clock()/1000))throw authFailure();
   return {principalId:binding.principal_id,provider:"line-staff"};
  }catch{throw authFailure();}
 }
}
export class PostgresStaffIdentityDirectory{
 #query;
 constructor({query}){if(typeof query!=="function")throw new Error("QUERY_REQUIRED");this.#query=query;}
 async findLineBinding({tenant_id:t,facility_id:f,channel_id:c,line_subject:s}){
  if(!validKey(t)||!validKey(f)||!validChannel(c)||!validSubject(s))return null;
  const result=await this.#query("select b.tenant_id, g.facility_id, b.channel_id, b.line_subject, b.principal_id, b.active from personalized_care.line_staff_binding b join personalized_care.facility_membership g on g.tenant_id=b.tenant_id and g.principal_id=b.principal_id where b.tenant_id=$1 and g.facility_id=$2 and b.channel_id=$3 and b.line_subject=$4 and b.active and g.active limit 2",[t,f,c,s]);
  if(!Array.isArray(result?.rows)||result.rows.length!==1)return null;
  const r=result.rows[0];
  return r?.active===true&&r.tenant_id===t&&r.facility_id===f&&r.channel_id===c&&r.line_subject===s&&validPrincipal(r.principal_id)?r:null;
 }
 async facilityGrant(t,f,p){
  if(!validKey(t)||!validKey(f)||!validPrincipal(p))return null;
  const result=await this.#query("select tenant_id, facility_id, principal_id, roles, active from personalized_care.facility_membership where tenant_id=$1 and facility_id=$2 and principal_id=$3 and active limit 2",[t,f,p]);
  if(!Array.isArray(result?.rows)||result.rows.length!==1)return null;
  const r=result.rows[0];
  if(r?.active!==true||r.tenant_id!==t||r.facility_id!==f||r.principal_id!==p||!Array.isArray(r.roles)||!r.roles.length||r.roles.some(x=>!["supervisor","dispatcher","responder","auditor"].includes(x)))return null;
  return {...r,roles:[...r.roles]};
 }
}
