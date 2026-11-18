import test from "node:test";
import assert from "node:assert/strict";
import { makeFixture } from "./personalized-care-fixture.mjs";
import { seedDemo } from "../src/personalized-care/index.mjs";
import { dispatchPersonalized } from "../src/personalized-care/http.mjs";
test("operator projection, current choice and follow-up review routes",async()=>{
 const {service:s,req}=makeFixture();await seedDemo(s,req);
 const base="/api/personalized-care/tenants/single/facilities/f1";
 assert.equal((await dispatchPersonalized(s,"supervisor","GET",base+"/operator")).can_review,true);
 assert.equal((await dispatchPersonalized(s,"staff","GET",base+"/operator")).can_review,false);
 const blocked=await dispatchPersonalized(s,"staff","POST",base+"/guides",{resident_id:"a",category:"greeting",current_choice:{category:"wake_time",value:"朝9時"}});
 assert.equal(blocked.blocked,true);
 const g=await s.guide(req,"a","greeting");await s.record(req,{interaction_id:"ui",resident_id:"a",interaction_type:"greeting",sop_id:g.applicable_sop,sop_version:g.sop_version,resident_context_version:g.resident_context_version,guide_token:g.guide_token,action_summary:"架空",status:"FOLLOWUP",followup_required:true,human_confirmed:true,confirmed_checks:g.required_confirmations});
 assert.equal((await dispatchPersonalized(s,"staff","GET",base+"/followups")).length,1);
 const v=await dispatchPersonalized(s,"supervisor","POST",base+"/interactions/ui/review",{expected_version:1,decision:"CONTINUE_FOLLOWUP",reason:"確認",human_confirmed:true});assert.equal(v.version,2);
 await assert.rejects(()=>dispatchPersonalized(s,"staff","POST",base+"/interactions/ui/review",{expected_version:2,decision:"NO_FURTHER_ACTION",reason:"確認",human_confirmed:true}),/FORBIDDEN/);
});
