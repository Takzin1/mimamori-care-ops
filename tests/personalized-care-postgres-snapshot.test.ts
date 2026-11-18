import test from "node:test";
import assert from "node:assert/strict";
import { PostgresSnapshotRepository } from "../src/personalized-care/postgres-snapshot.mjs";
async function pgContract(PostgresSnapshotRepository,check){
 const t="demo",f="f1",c={principalId:"staff",actorId:"actor",roles:["responder"],provider:"line-staff",lineBinding:{channel_id:"123",line_subject:"U"+"a".repeat(32)}};
 const p=JSON.stringify({format:1,audit:[{actor_id:"actor",action:"guide_read",ref:"a",at:"2026-11-18T00:00:00.000Z"}]});
 let calls=[],active=true,roles=["responder"],snapshot=null,conflict=false,journalError=false,commitError=false,release=[],result=[];
 const pool={async connect(){let staged=snapshot;return {async query(q,args=[]){calls.push([q,args]);if(q.includes("SELECT m.actor_id"))return {rows:active?[{actor_id:"actor",roles}]:[]};if(q.startsWith("SELECT version"))return {rows:snapshot?[snapshot]:[]};if(q.startsWith("INSERT INTO personalized_care.scope_snapshot")||q.startsWith("UPDATE personalized_care.scope_snapshot")){if(conflict)return {rows:[]};const n=q.startsWith("INSERT")?1:Number(args[2])+1;staged={version:String(n),payload:q.startsWith("INSERT")?args[2]:args[3]};return {rows:[{version:String(n)}]};}if(q.includes("scope_audit_journal")&&journalError)throw Error("journal error");if(q==="COMMIT"){if(commitError)throw Object.assign(Error("serialization"),{code:"40001"});snapshot=staged;}return {rows:[]};},release(v){release.push(v);}};}};
 const repo=new PostgresSnapshotRepository({pool});
 async function test(name,fn){calls=[];try{await fn();result.push([name,"PASS"]);}catch(e){result.push([name,"FAIL",String(e)]);}}
 async function reject(fn,code){let e;try{await fn();}catch(err){e=err;}check(e?.message===code,"expected "+code+" got "+e?.message);}
 await test("initial load and SET LOCAL scope",async()=>{check(await repo.load(t,f,c)===null);check(calls[0][0].includes("SERIALIZABLE")&&calls.some(([q,a])=>q.includes("set_config")&&a.join(",")==="demo,f1,staff")&&calls.at(-1)[0]==="COMMIT");});
 await test("write and audit journal atomic contract",async()=>{check(await repo.save(t,f,0,p,c)===1);check(calls.some(([q,a])=>q.includes("scope_audit_journal")&&a[2]===1&&a[3]==="actor"));check(calls.at(-1)[0]==="COMMIT"&&release.at(-1)===false);});
 await test("restore stored version",async()=>{const got=await repo.load(t,f,c);check(got.version===1&&got.payload===p);});
 await test("denied revoked membership or changed roles",async()=>{active=false;await reject(()=>repo.load(t,f,c),"SNAPSHOT_ACCESS_DENIED");check(calls.at(-1)[0]==="ROLLBACK");active=true;roles=["supervisor"];await reject(()=>repo.save(t,f,1,p,c),"SNAPSHOT_ACCESS_DENIED");roles=["responder"];});
 await test("untrusted provider rejected before database call",async()=>{const prior=calls.length;await reject(()=>repo.load(t,f,{...c,provider:"synthetic"}),"SNAPSHOT_ACCESS_DENIED");check(calls.length===prior);});
 await test("CAS conflict rolls back without journal write",async()=>{conflict=true;await reject(()=>repo.save(t,f,1,p,c),"SNAPSHOT_VERSION_CONFLICT");check(!calls.some(([q])=>q.includes("scope_audit_journal"))&&calls.at(-1)[0]==="ROLLBACK");conflict=false;});
 await test("audit failure prevents commit",async()=>{journalError=true;await reject(()=>repo.save(t,f,1,p,c),"SNAPSHOT_UNAVAILABLE");check(snapshot.version==="1"&&calls.at(-1)[0]==="ROLLBACK"&&release.at(-1)===true);journalError=false;});
 await test("serialization error never reports success",async()=>{commitError=true;await reject(()=>repo.save(t,f,1,p,c),"SNAPSHOT_VERSION_CONFLICT");check(snapshot.version==="1"&&calls.at(-1)[0]==="ROLLBACK");commitError=false;});
 await test("forged audit actor denied",async()=>reject(()=>repo.save(t,f,1,p.replace('"actor"','"other"'),c),"SNAPSHOT_CORRUPT"));
 return result;
}
test("staging PostgreSQL repository contract (mock pool)",async()=>{for(const [name,status,error] of await pgContract(PostgresSnapshotRepository,(v,m)=>assert.ok(v,m)))assert.equal(status,"PASS",name+": "+(error??""));});
