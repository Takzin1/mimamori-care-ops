// Integration helper for a separately hosted HTTPS LINE staff shell. Does not load an SDK.
export function createLiffStaffClient({liff,liffId,origin,tenantId,facilityId,fetchImpl=fetch}){
 const key=x=>typeof x==="string"&&/^[A-Za-z0-9._:-]{1,64}$/.test(x);
 if(!liff||typeof liff.init!=="function"||typeof liff.getIDToken!=="function"||typeof liff.isLoggedIn!=="function"||typeof liffId!=="string"||!liffId||!key(tenantId)||!key(facilityId))throw Error("INVALID_LIFF_CONFIG");
 const base=new URL(origin);
 if(base.protocol!=="https:"||base.origin!==origin||base.username||base.password)throw Error("HTTPS_ORIGIN_REQUIRED");
 if(typeof window!=="undefined"&&window.location.origin!==origin)throw Error("ORIGIN_MISMATCH");
 const path="/api/personalized-care/tenants/"+encodeURIComponent(tenantId)+"/facilities/"+encodeURIComponent(facilityId);
 let initialized=false;
 return {
  async initialize(){await liff.init({liffId});initialized=true;return {loggedIn:liff.isLoggedIn()===true};},
  async request(route,{method="GET",body}={}){
   if(!initialized||!liff.isLoggedIn())throw Error("LINE_LOGIN_REQUIRED");
   if(typeof route!=="string"||!/^\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+){0,2}$/.test(route)||route.split("/").some(x=>x==="."||x==="..")||!["GET","POST"].includes(method)||method==="GET"&&body!==undefined||method==="POST"&&(body===null||typeof body!=="object"||Array.isArray(body)))throw Error("INVALID_REQUEST");
   const token=liff.getIDToken();
   if(typeof token!=="string"||!token||token.length>8192)throw Error("LINE_LOGIN_REQUIRED");
   const response=await fetchImpl(path+route,{method,headers:{authorization:"Bearer "+token,accept:"application/json",...(method==="POST"?{"content-type":"application/json"}:{})},...(method==="POST"?{body:JSON.stringify(body)}:{}),credentials:"omit",cache:"no-store",redirect:"error"});
   if(!response.ok)throw Error(response.status===401?"LINE_LOGIN_REQUIRED":response.status===403||response.status===404?"ACCESS_DENIED":"REQUEST_REJECTED");
   return response.json();
  }
 };
}
