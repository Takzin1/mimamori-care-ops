import { readBoundedJson } from "../http/body.ts";
function routeError(code,status=400){throw Object.assign(new Error(code),{status});}
export async function dispatchPersonalized(service,accessToken,method,path,body=null){
  const decode=raw=>{let x;try{x=decodeURIComponent(raw);}catch{routeError("INVALID_PATH");}if(!/^[A-Za-z0-9._:-]{1,64}$/.test(x))routeError("INVALID_PATH");return x;};
  const p=path.split("/");
  if(p.length<8||p[1]!=="api"||p[2]!=="personalized-care"||p[3]!=="tenants"||p[5]!=="facilities")routeError("NOT_FOUND",404);
  const req={accessToken,tenant_id:decode(p[4]),facility_id:decode(p[6])},r=p[7],key=p.length===9?decode(p[8]):null;
  if(method==="POST"&&(!body||typeof body!=="object"||Array.isArray(body)))routeError("INVALID_OBJECT");
  if(method==="GET"&&p.length===8&&r==="residents")return service.residents(req);
  if(method==="GET"&&key&&r==="residents")return service.resident(req,key);
  if(method==="GET"&&key&&r==="sops")return service.sopHistory(req,key);
  if(method==="GET"&&p.length===8&&r==="academy")return service.academy(req);
  if(method==="GET"&&p.length===8&&r==="lesson-sources")return service.lessonSources(req);
  if(method==="GET"&&p.length===8&&r==="lesson-admin")return service.lessonAdmin(req);
  if(method==="GET"&&p.length===8&&r==="knowledge-coverage")return service.knowledgeCoverage(req);
  if(method==="GET"&&p.length===8&&r==="operator")return service.operator(req);
  if(method==="GET"&&p.length===8&&r==="followups")return service.followups(req);
  if(method==="GET"&&p.length===8&&r==="audit")return service.audit(req);
  if(method==="POST"&&p.length===8){
    switch(r){
      case "residents":return service.putResident(req,body);
      case "preferences":return service.putPreference(req,body);
      case "sops":return service.putSop(req,body);
      case "sop-transitions":return service.transitionSop(req,body);
      case "resident-deletions":await service.deleteResident(req,body.resident_id,body.expected_version);return {deleted:true};
      case "lesson-drafts":return service.draftLesson(req,body);
      case "lesson-transitions":return service.transitionLesson(req,body);
      case "lesson-practice":return service.practiceLesson(req,body);
      case "knowledge-search":return service.searchKnowledge(req,body);
      case "guides":return service.guide(req,body.resident_id,body.category,body.current_choice??null);
      case "interactions":return service.record(req,body);
    }
  }
  if(method==="POST"&&p.length===10&&r==="interactions"&&p[9]==="review")return service.reviewFollowup(req,decode(p[8]),body);
  if(method==="POST"&&p.length===10&&r==="interactions"&&p[9]==="promote")return service.promote(req,decode(p[8]),body.expected_version,body.priority);
  routeError("NOT_FOUND",404);
}
export class PersonalizedCareHttpApi {
  #service;
  constructor(service){this.#service=service;}
  async handle(request){
    const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","vary":"Authorization"};
    const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
    try{
      const m=/^Bearer ([^\s,]+)$/i.exec(request.headers.get("authorization")??"");
      if(!m||m[1].length>8192)routeError("AUTH_REQUIRED",401);
      if(!["GET","POST"].includes(request.method))routeError("METHOD_NOT_ALLOWED",405);
      const body=request.method==="POST"?await readBoundedJson(request,32768):null;
      return json(await dispatchPersonalized(this.#service,m[1],request.method,new URL(request.url).pathname,body));
    }catch(e){
      const status=[400,401,403,404,405,409,413,415,503].includes(e?.status)?e.status:500;
      const code=status===500?"INTERNAL_ERROR":(/^[A-Z_]{1,80}$/.test(e?.code??"")?e.code:/^[A-Z_]{1,80}$/.test(e?.message??"")?e.message:"REQUEST_REJECTED");
      return json({error:{code}},status);
    }
  }
}
