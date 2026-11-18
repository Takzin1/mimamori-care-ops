// Separate opt-in synthetic preview. Not wired to the existing deployment or main server.
import { PersonalizedCareService } from "./index.mjs";
import { PersonalizedCareHttpApi } from "./http.mjs";
import { LineStaffAuthenticator } from "./line-staff-identity.mjs";
import { PostgresSnapshotRepository } from "./postgres-snapshot.mjs";
export function createLineStaffPreview({syntheticOnly,channelId,directory,memberships,origin,fetchImpl,clock,stagingPool=null}){
 if(syntheticOnly!==true)throw Error("SYNTHETIC_ONLY");
 const u=new URL(origin);if(u.protocol!=="https:"||u.origin!==origin)throw Error("HTTPS_ORIGIN_REQUIRED");
 const auth=new LineStaffAuthenticator({channelId,directory,fetchImpl});
 const snapshots=stagingPool?new PostgresSnapshotRepository({pool:stagingPool}):null;
 const service=new PersonalizedCareService({authenticator:auth,memberships,facilityGrant:(t,f,p)=>directory.facilityGrant(t,f,p),clock,snapshotRepository:snapshots});
 // No CaseService. Only explicit synthetic staging persistence; existing runtime remains unchanged.
 const api=new PersonalizedCareHttpApi(service);
 return {async handle(request){
  const url=new URL(request.url),source=request.headers.get("origin"),site=request.headers.get("sec-fetch-site");
  if(url.origin!==origin||url.protocol!=="https:"||source&&source!==origin||request.method==="POST"&&source!==origin||site==="cross-site"){
   return new Response(JSON.stringify({error:{code:"ORIGIN_DENIED"}}),{status:403,headers:{"content-type":"application/json","cache-control":"no-store"}});
  }
  return api.handle(request);
 }};
}
