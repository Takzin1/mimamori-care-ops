// Synthetic data only. Node >=24. Never bind externally.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PersonalizedCareService, seedDemo } from "../src/personalized-care/index.mjs";
import { PersonalizedCareHttpApi } from "../src/personalized-care/http.mjs";
import { CaseService } from "../src/application/case-service.ts";
import { InMemoryCaseRepository } from "../src/persistence/in-memory-case-repository.ts";
import { InMemoryTenantMembershipDirectory } from "../src/access/in-memory-membership-directory.ts";
const host="127.0.0.1",port=8787,origin="http://"+host+":"+port;
const token=randomBytes(32).toString("hex");
const membership={tenantId:"demo",principalId:"synthetic-supervisor",actorId:"synthetic-supervisor",roles:["supervisor"],active:true};
const memberships=new InMemoryTenantMembershipDirectory([membership]);
const authenticator={async authenticate(t){if(t!==token)throw Error("invalid");return {principalId:membership.principalId,provider:"synthetic"};}};
const cases=new CaseService(new InMemoryCaseRepository(),memberships);
const service=new PersonalizedCareService({authenticator,memberships,caseService:cases,
 facilityGrant:async(t,f,p)=>t==="demo"&&f==="facility-1"&&p===membership.principalId?{tenant_id:t,facility_id:f,principal_id:p,roles:["supervisor"],active:true}:null,
 caseBinding:async(t,f)=>t==="demo"&&f==="facility-1"?{tenant_id:t,facility_id:f,facility_exclusive:true}:null});
await seedDemo(service,{tenant_id:"demo",facility_id:"facility-1",accessToken:token});
const api=new PersonalizedCareHttpApi(service);
const assets=new Map([["/",["index.html","text/html; charset=utf-8"]],["/app.js",["app.js","text/javascript; charset=utf-8"]],["/style.css",["style.css","text/css; charset=utf-8"]]]);
const security={"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY","content-security-policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
const server=createServer(async(req,res)=>{
  try{
    if(req.headers.host!==host+":"+port||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403,security).end();return;}
    const url=new URL(req.url??"/",origin);
    if(url.origin!==origin){res.writeHead(403,security).end();return;}
    if(req.method==="GET"&&assets.has(url.pathname)){
      const [file,type]=assets.get(url.pathname);const data=await readFile(new URL("../demo/personalized-care/"+file,import.meta.url));
      res.writeHead(200,{...security,"content-type":type});res.end(data);return;
    }
    if(!url.pathname.startsWith("/api/personalized-care/")){res.writeHead(404,security).end();return;}
    const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(typeof v==="string")headers.set(k,v);
    const init={method:req.method,headers};
    if(!["GET","HEAD"].includes(req.method??"")){init.body=Readable.toWeb(req);init.duplex="half";}
    const response=await api.handle(new Request(url,init));res.writeHead(response.status,{...security,...Object.fromEntries(response.headers.entries())});res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.headersSent)res.writeHead(500,security);res.end();}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(port,host,()=>{console.log("Synthetic demo: "+origin);console.log("Session token (local synthetic demo only): "+token);});
