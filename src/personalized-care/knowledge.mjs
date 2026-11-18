// Read-only retrieval, no external provider or generated answer. SOP text is data.
const norm=s=>s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,"");
function grams(s){const chars=Array.from(s);return new Set(chars.slice(0,-1).map((c,i)=>c+chars[i+1]));}
const fields=[["title","表題"],["description","概要"],["trigger_conditions","対象場面"],["steps","手順"],["required_checks","確認事項"],["prohibited_actions","禁止事項"],["escalation_conditions","責任者への相談"],["completion_requirements","完了条件"]];
function active({sops,tenantId,facilityId,category,roles,asOf}){
 const candidates=sops.filter(s=>s.tenant_id===tenantId&&s.facility_id===facilityId&&s.category===category&&s.approval_status==="APPROVED"&&s.effective_from<=asOf);
 if(candidates.length!==1)return {state:candidates.length?"AMBIGUOUS":"UNAVAILABLE",sop:null};
 const s=candidates[0];return Array.isArray(s.allowed_roles)&&s.allowed_roles.some(r=>roles.includes(r))?{state:"AVAILABLE",sop:s}:{state:"UNAVAILABLE",sop:null};
}
export function knowledgeCoverage({categories,...scope}){
 return categories.map(category=>{const {state,sop}=active({...scope,category});return {category,state,sop_id:sop?.sop_id??null,version:sop?.version??null};});
}
export function retrieveSopEvidence({query,...scope}){
 const q=norm(query),qg=grams(q);
 const empty=state=>({state,category:scope.category,results:[],human_confirmation_required:true,automatic_action:false,generated_answer:null});
 if(["emergency","irregular"].includes(scope.category))return empty("CONSULT_REQUIRED");
 if(!qg.size)return empty("QUERY_TOO_SHORT");
 const {state,sop}=active(scope);if(!sop)return empty(state==="AMBIGUOUS"?"CONSULT_REQUIRED":"UNAVAILABLE");
 const hits=[];
 for(const [field,label] of fields){
  const values=Array.isArray(sop[field])?sop[field]:[sop[field]];
  for(const [index,quote] of values.entries()){
   if(typeof quote!=="string"||!quote)continue;
   const t=norm(quote),tg=grams(t);let overlap=0;for(const g of qg)if(tg.has(g))overlap++;
   const exact=t.includes(q),ratio=overlap/qg.size;
   if(!exact&&(overlap<2||ratio<0.5))continue;
   hits.push({score:(exact?10000:0)+Math.round(ratio*1000)+overlap,match_type:exact?"EXACT":"PARTIAL",field,index,label,quote,evidence_id:sop.sop_id+":"+sop.version+":"+field+":"+index,sop_id:sop.sop_id,version:sop.version,revision:sop.revision,source_reference:sop.source_reference,title:sop.title});
  }
 }
 hits.sort((a,b)=>b.score-a.score||(a.evidence_id<b.evidence_id?-1:a.evidence_id>b.evidence_id?1:0));
 return hits.length?{...empty("EVIDENCE_FOUND"),results:hits.slice(0,5).map(({score,...r})=>r)}:empty("NO_MATCH");
}
