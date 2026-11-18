import {test} from "node:test";
import assert from "node:assert/strict";
import {PersonalizedCareHttpApi} from "../src/personalized-care/http.mjs";
import {seedDemo} from "../src/personalized-care/index.mjs";
import {makeFixture} from "./personalized-care-fixture.mjs";
test("personalized HTTP scope, authentication and bounded JSON",async()=>{
 const {service,req}=makeFixture();await seedDemo(service,req);const api=new PersonalizedCareHttpApi(service);
 const base="https://example.test/api/personalized-care/tenants/single/facilities/f1";
 const call=(path,method="GET",body=undefined,token="supervisor")=>api.handle(new Request(base+path,{method,headers:{Authorization:"Bearer "+token,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body})}));
 assert.equal((await call("/residents")).status,200);
 assert.equal((await call("/residents","GET",undefined,"bad")).status,401);
 assert.equal((await api.handle(new Request(base.replace("f1","f2")+"/residents",{headers:{Authorization:"Bearer supervisor"}}))).status,404);
 assert.equal((await call("/guides","POST","null")).status,400);
 assert.equal((await call("/guides","POST",JSON.stringify({x:"x".repeat(33000)}))).status,413);
 assert.equal((await call("/guides","POST",JSON.stringify({resident_id:"a",category:"greeting"}))).status,200);
 assert.equal((await call("/complete-case","POST","{}")).status,404);
});
