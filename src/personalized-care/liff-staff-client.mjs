// Integration helper for a separately hosted HTTPS LINE staff shell. Does not load an SDK.
export function createLiffStaffClient({liff,liffId,origin,tenantId,facilityId,fetchImpl=fetch}){
 const key=x=>typeof x==="string"&&/^[A-Za-z0-9._:-]{1,64}$/.test(x);
 if(!liff||typeof liff.init!=="function"||typeof liff.getIDToken!=="function"||typeof liff.isLoggedIn!=="function"||typeof liffId!=="string"||!liffId||!key(tenantId)||!key(facilityId))throw Error("INVALID_LIFF_CONFIG");
 const base=new URL(origin);
 if(base.protocol!=="https:"||base.origin!==origin||base.username||base.password)throw Error("HTTPS_ORIGIN_REQUIRED");
 if(typeof window!=="undefined"&&window.location.origin!==origin)throw Error("ORIGIN_MISMATCH");
 const path="/api/personalized-care/tenants/"+encodeURIComponent(tenantId)+"/facilities/"+encodeURIComponent(facilityId);
 let initialized=false,generation=0;
 const invalidate=()=>{initialized=false;generation++;};
 return {
  invalidate,
  async initialize(){invalidate();const round=generation;await liff.init({liffId});if(round!==generation)throw Error("LINE_LOGIN_REQUIRED");initialized=liff.isLoggedIn()===true;return {loggedIn:initialized};},
  async request(route,{method="GET",body}={}){
   if(!initialized||!liff.isLoggedIn()){invalidate();throw Error("LINE_LOGIN_REQUIRED");}
   const round=generation;
   if(typeof route!=="string"||!/^\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+){0,2}$/.test(route)||route.split("/").some(x=>x==="."||x==="..")||!["GET","POST"].includes(method)||method==="GET"&&body!==undefined||method==="POST"&&(body===null||typeof body!=="object"||Array.isArray(body)))throw Error("INVALID_REQUEST");
   const token=liff.getIDToken();
   if(typeof token!=="string"||!token||token.length>8192){invalidate();throw Error("LINE_LOGIN_REQUIRED");}
   const response=await fetchImpl(path+route,{method,headers:{authorization:"Bearer "+token,accept:"application/json",...(method==="POST"?{"content-type":"application/json"}:{})},...(method==="POST"?{body:JSON.stringify(body)}:{}),credentials:"omit",cache:"no-store",redirect:"error"});
   if(round!==generation)throw Error("LINE_LOGIN_REQUIRED");
   if(response.status===401){invalidate();throw Error("LINE_LOGIN_REQUIRED");}
   if(!response.ok)throw Error(response.status===403||response.status===404?"ACCESS_DENIED":"REQUEST_REJECTED");
   const result=await response.json();if(round!==generation||!liff.isLoggedIn()){if(round===generation)invalidate();throw Error("LINE_LOGIN_REQUIRED");}return result;
  }
 };
}
