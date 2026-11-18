// Synthetic data only. Node >=24. Never bind externally.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { SyntheticSqliteSnapshotRepository } from "../src/personalized-care/synthetic-sqlite.mjs";
import { readFile } from "node:fs/promises";
import { PersonalizedCareService, seedDemo, seedAcademyDemo } from "../src/personalized-care/index.mjs";
import { PersonalizedCareHttpApi } from "../src/personalized-care/http.mjs";
import { CaseService } from "../src/application/case-service.ts";
import { InMemoryCaseRepository } from "../src/persistence/in-memory-case-repository.ts";
import { InMemoryTenantMembershipDirectory } from "../src/access/in-memory-membership-directory.ts";
const host="127.0.0.1",port=8787,origin="http://"+host+":"+port;
const token=randomBytes(32).toString("hex"),reviewerToken=randomBytes(32).toString("hex");
const membership={tenantId:"demo",principalId:"synthetic-supervisor",actorId:"synthetic-supervisor",roles:["supervisor"],active:true};
const reviewer={...membership,principalId:"synthetic-reviewer",actorId:"synthetic-reviewer"};
const memberships=new InMemoryTenantMembershipDirectory([membership,reviewer]);
const authenticator={async authenticate(t){const row=t===token?membership:t===reviewerToken?reviewer:null;if(!row)throw Error("invalid");return {principalId:row.principalId,provider:"synthetic"};}};
const snapshotMode=process.argv.includes("--persist");
const snapshots=snapshotMode?new SyntheticSqliteSnapshotRepository(".personalized-care-local/synthetic.sqlite"):null;
const cases=new CaseService(new InMemoryCaseRepository(),memberships);
const service=new PersonalizedCareService({authenticator,memberships,caseService:cases,snapshotRepository:snapshots,
 facilityGrant:async(t,f,p)=>t==="demo"&&f==="facility-1"&&[membership.principalId,reviewer.principalId].includes(p)?{tenant_id:t,facility_id:f,principal_id:p,roles:["supervisor"],active:true}:null,
 caseBinding:async(t,f)=>t==="demo"&&f==="facility-1"?{tenant_id:t,facility_id:f,facility_exclusive:true}:null});
const demoScope={tenant_id:"demo",facility_id:"facility-1",accessToken:token};
// Seed only a new scope; a failed seed is not silently overwritten. Reset synthetic DB manually if needed.
if(!snapshots?.load("demo","facility-1")){await seedDemo(service,demoScope);await seedAcademyDemo(service,demoScope,{...demoScope,accessToken:reviewerToken});}
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
server.listen(port,host,()=>{console.log("Synthetic demo: "+origin+(snapshotMode?" (persistent synthetic; Case promotion disabled)":" (memory)"));console.log("Session token (local synthetic demo only): "+token);console.log("Independent synthetic reviewer token: "+reviewerToken);});
