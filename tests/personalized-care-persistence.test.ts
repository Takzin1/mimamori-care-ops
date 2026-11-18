import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyntheticSqliteSnapshotRepository } from "../src/personalized-care/synthetic-sqlite.mjs";
import { seedDemo } from "../src/personalized-care/index.mjs";
import { makeFixture } from "./personalized-care-fixture.mjs";
async function advancedContract(makeFixture,seedDemo,check){
  const rows=new Map();
  const repository={load(t,f){return rows.get(JSON.stringify([t,f]))??null;},save(t,f,v,payload){const k=JSON.stringify([t,f]),existing=rows.get(k);if((existing?.version??0)!==v)throw Object.assign(Error("SNAPSHOT_VERSION_CONFLICT"),{status:409});rows.set(k,{version:v+1,payload});return v+1;}};
  const a=makeFixture(null,{snapshotRepository:repository}),req=a.req;
  const s=a.service;await seedDemo(s,req);
  const b=makeFixture(null,{snapshotRepository:repository}).service;
  const result=[];
  async function test(name,fn){try{await fn();result.push([name,"PASS"]);}catch(e){result.push([name,"FAIL",String(e)]);}}
  async function rejects(fn,code){let e;try{await fn();}catch(err){e=err;}check(e?.message===code,"expected "+code+" got "+e?.message);}
  await test("restart and scope isolation",async()=>{check((await b.residents(req)).length===3);check((await b.residents(a.other)).length===0);});
  await test("cross-resident guide token",async()=>{const x=await b.guide(req,"a","greeting"),y=await b.guide(req,"b","greeting");check(x.guide_token!==y.guide_token);});
  const g=await b.guide(req,"a","greeting");
  const input={interaction_id:"follow",resident_id:"a",interaction_type:"greeting",sop_id:g.applicable_sop,sop_version:g.sop_version,resident_context_version:g.resident_context_version,guide_token:g.guide_token,action_summary:"架空の申し送り",status:"FOLLOWUP",followup_required:true,human_confirmed:true,confirmed_checks:g.required_confirmations};
  await test("record durable and audit same snapshot",async()=>{await b.record(req,input);check((await s.followups(req)).length===1);check((await s.audit(req)).some(x=>x.action==="interaction_recorded"));});
  await test("durable promotion fail closed",async()=>rejects(()=>s.promote(req,"follow",1,"normal"),"DURABLE_CASE_INTEGRATION_REQUIRED"));
  await test("supervisor review RBAC",async()=>rejects(()=>s.reviewFollowup({...req,accessToken:"staff"},"follow",{expected_version:1,human_confirmed:true,decision:"CONTINUE_FOLLOWUP",reason:"架空"}),"FORBIDDEN"));
  await test("review optimistic lock and no case completion",async()=>{const r=await s.reviewFollowup(req,"follow",{expected_version:1,human_confirmed:true,decision:"REQUEST_CASE",reason:"継続確認（架空）"});check(r.version===2);await rejects(()=>b.reviewFollowup(req,"follow",{expected_version:1,human_confirmed:true,decision:"CONTINUE_FOLLOWUP",reason:"架空"}),"VERSION_CONFLICT");check((await b.followups(req))[0].case_linked===false);});
  await test("explicit review removal from queue",async()=>{await b.reviewFollowup(req,"follow",{expected_version:2,human_confirmed:true,decision:"NO_FURTHER_ACTION",reason:"本人確認完了（架空）"});check((await s.followups(req)).length===0);check((await s.resident(req,"a")).interactions[0].review_history.length===2);});
  await test("consent revocation and regrant require re-verification",async()=>{let p=(await s.resident(req,"c")).profile;const withdrawn=await s.putResident(req,{...p,expected_version:p.profile_version,consent_status:"withdrawn"});await rejects(()=>b.guide(req,"c","greeting"),"NOT_FOUND");await s.putResident(req,{...withdrawn,expected_version:withdrawn.profile_version,consent_status:"granted"});check((await b.guide(req,"c","greeting")).personalized_considerations.length===0);});
  await test("failed CAS does not mutate stored state",async()=>{const prior=repository.load("single","f1");const failing={load:repository.load,save(){throw Error("SNAPSHOT_VERSION_CONFLICT");}};const c=makeFixture(null,{snapshotRepository:failing}).service;await rejects(()=>c.putResident(req,{resident_id:"new",expected_version:0,display_name:"架空",preferred_name:"架空",room_number:"104",consent_status:"granted"}),"SNAPSHOT_VERSION_CONFLICT");check(repository.load("single","f1")===prior);});
  return result;
}
test("snapshot service and review contract",async()=>{for(const [name,status,error] of await advancedContract(makeFixture,seedDemo,(v,m)=>assert.ok(v,m)))assert.equal(status,"PASS",name+": "+(error??""));});
test("real SQLite restart and compare-and-swap",async()=>{const dir=mkdtempSync(join(tmpdir(),"pc-synthetic-"));const path=join(dir,"test.sqlite");let a,b;try{a=new SyntheticSqliteSnapshotRepository(path);assert.equal(a.save("t","f",0,"{}"),1);b=new SyntheticSqliteSnapshotRepository(path);assert.equal(b.load("t","f").version,1);assert.equal(b.save("t","f",1,"{\"x\":1}"),2);assert.throws(()=>a.save("t","f",1,"{}"),/SNAPSHOT_VERSION_CONFLICT/);assert.equal(a.load("t","other"),null);a.close();a=null;b.close();b=null;a=new SyntheticSqliteSnapshotRepository(path);assert.equal(a.load("t","f").payload,'{"x":1}');const {service,req}=makeFixture(null,{snapshotRepository:a});await seedDemo(service,req);a.close();a=null;b=new SyntheticSqliteSnapshotRepository(path);assert.equal((await makeFixture(null,{snapshotRepository:b}).service.residents(req)).length,3);}finally{a?.close();b?.close();rmSync(dir,{recursive:true,force:true});}});
