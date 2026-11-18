import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixture, contract } from "./personalized-care-fixture.mjs";
import { CaseService } from "../src/application/case-service.ts";
import { InMemoryCaseRepository } from "../src/persistence/in-memory-case-repository.ts";
import { InMemoryTenantMembershipDirectory } from "../src/access/in-memory-membership-directory.ts";
test("personalized care: contract and existing CaseService", async () => {
 const repository = new InMemoryCaseRepository();
 const members = new InMemoryTenantMembershipDirectory([{tenantId:"single",principalId:"supervisor",actorId:"supervisor",roles:["supervisor"],active:true}]);
 const cases = new CaseService(repository,members,()=>"2026-11-18T00:00:00.000Z");
 for (const [name,status,error] of await contract(()=>makeFixture(cases), (value,message)=>assert.ok(value,message))) assert.equal(status,"PASS",name+": "+(error??""));
 const rows=await repository.list("single");
 assert.equal(rows.length,1);
 assert.equal(rows[0].aggregate.status,"NEW");
 assert.equal(rows[0].aggregate.sourceAdapter,"personalized-care");
 assert.equal(rows[0].events.length,1);
});
