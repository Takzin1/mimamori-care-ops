import test from "node:test";
import assert from "node:assert/strict";
import {LineStaffAuthenticator,PostgresStaffIdentityDirectory} from "../src/personalized-care/line-staff-identity.mjs";
import {makeFixture} from "./personalized-care-fixture.mjs";
import {createLiffStaffClient} from "../src/personalized-care/liff-staff-client.mjs";
async function identityContract(LineStaffAuthenticator,PostgresStaffIdentityDirectory,makeFixture,check){
 const now=1760000000000,sub="U"+"a".repeat(32),scope={tenant_id:"single",facility_id:"f1"},channel="1234567890",token="abc.def.ghi";
 const claims={iss:"https://access.line.me",aud:channel,sub,iat:now/1000-60,exp:now/1000+600};
 let body={...claims},binding=true,grant=true,last=null,code=200,net=false;
 const directory={async findLineBinding(x){return binding?{...x,principal_id:"staff",active:true}:null;}};
 const fetchImpl=async(url,init)=>{last={url,init};if(net)throw Error("network");return {ok:code===200,json:async()=>body};};
 const auth=new LineStaffAuthenticator({channelId:channel,directory,fetchImpl,clock:()=>now,timeoutSignal:()=>undefined});
 let results=[];
 async function test(n,fn){try{await fn();results.push([n,"PASS"]);}catch(e){results.push([n,"FAIL",String(e)]);}}
 async function denies(fn,expected="AUTHENTICATION_FAILED"){let e;try{await fn();}catch(err){e=err;}check(e?.message===expected,"expected "+expected+" got "+e?.message);}
 await test("verified LINE token maps to enrolled principal",async()=>{check((await auth.authenticate(token,scope)).principalId==="staff");check(last.url==="https://api.line.me/oauth2/v2.1/verify"&&last.init.body.includes("client_id="+channel)&&last.init.redirect==="error");});
 await test("raw subject cannot authenticate",async()=>denies(()=>auth.authenticate(sub,scope)));
 await test("wrong channel and issuer rejected",async()=>{for(const patch of [{aud:"999"},{iss:"https://evil.test"}]){body={...claims,...patch};await denies(()=>auth.authenticate(token,scope));}body={...claims};});
 await test("expired and future-issued tokens denied",async()=>{for(const patch of [{exp:now/1000},{iat:now/1000+100}]){body={...claims,...patch};await denies(()=>auth.authenticate(token,scope));}body={...claims};});
 await test("unbound or revoked user denied",async()=>{binding=false;await denies(()=>auth.authenticate(token,scope));binding=true;});
 await test("LINE outage fails closed",async()=>{net=true;await denies(()=>auth.authenticate(token,scope));net=false;code=400;await denies(()=>auth.authenticate(token,scope));code=200;});
 await test("existing tenant/facility roles remain mandatory",async()=>{const {service}=makeFixture(null,{authenticator:auth,facilityGrant:async(t,f,p)=>grant&&t==="single"&&f==="f1"&&p==="staff"?{tenant_id:t,facility_id:f,principal_id:p,roles:["supervisor","responder"],active:true}:null});const req={...scope,accessToken:token};check((await service.operator(req)).can_review===false);await denies(()=>service.operator({...req,facility_id:"f2"}),"NOT_FOUND");grant=false;await denies(()=>service.operator(req),"NOT_FOUND");grant=true;});
 let params,rows=[];
 const db=new PostgresStaffIdentityDirectory({query:async(q,p)=>{params={q,p};return {rows};}});
 await test("directory parameterized scope and exact response match",async()=>{rows=[{...scope,channel_id:channel,line_subject:sub,principal_id:"staff",active:true}];check((await db.findLineBinding({...scope,channel_id:channel,line_subject:sub})).principal_id==="staff");check(params.q.includes("$4")&&params.p[1]==="f1"&&params.p[3]===sub);rows=[{...rows[0],facility_id:"other"}];check(await db.findLineBinding({...scope,channel_id:channel,line_subject:sub})===null);});
 await test("ambiguous binding and invalid facility grants rejected",async()=>{rows=[{...scope,principal_id:"staff",roles:["responder"],active:true}];check((await db.facilityGrant("single","f1","staff")).roles[0]==="responder");rows=[{...rows[0],roles:["owner"]}];check(await db.facilityGrant("single","f1","staff")===null);rows=[rows[0],rows[0]];check(await db.facilityGrant("single","f1","staff")===null);});
 return results;
}
test("LINE identity and facility authorization",async()=>{for(const [name,status,error] of await identityContract(LineStaffAuthenticator,PostgresStaffIdentityDirectory,makeFixture,(v,m)=>assert.ok(v,m)))assert.equal(status,"PASS",name+": "+(error??""));});
test("LIFF client uses raw token and relative same-origin endpoint",async()=>{
 let last,loggedIn=true;
 const liff={async init(x){assert.equal(x.liffId,"synthetic");},isLoggedIn:()=>loggedIn,getIDToken:()=>"abc.def.ghi"};
 const client=createLiffStaffClient({liff,liffId:"synthetic",origin:"https://example.test",tenantId:"t",facilityId:"f",fetchImpl:async(url,init)=>{last={url,init};return {ok:true,json:async()=>({ok:true})};}});
 await assert.rejects(()=>client.request("/operator"),/LINE_LOGIN_REQUIRED/);
 await client.initialize();assert.deepEqual(await client.request("/operator"),{ok:true});assert.equal(last.url,"/api/personalized-care/tenants/t/facilities/f/operator");assert.equal(last.init.headers.authorization,"Bearer abc.def.ghi");assert.equal(last.init.redirect,"error");
 await assert.rejects(()=>client.request("/../operator"),/INVALID_REQUEST/);
 await assert.rejects(()=>client.request("https://evil.test"),/INVALID_REQUEST/);
 loggedIn=false;await assert.rejects(()=>client.request("/operator"),/LINE_LOGIN_REQUIRED/);
});
