// Learning only. No resident records, case commands, model calls or professional certification.
export const educationFields=["steps","required_checks","prohibited_actions","escalation_conditions","completion_requirements"];
export function lessonEvidence({sops,lesson,tenantId,facilityId,roles,asOf}){
 const candidates=sops.filter(s=>s.tenant_id===tenantId&&s.facility_id===facilityId&&s.category===lesson.category&&s.approval_status==="APPROVED"&&s.effective_from<=asOf);
 if(candidates.length!==1)return null;
 const s=candidates[0],e=lesson.evidence;
 if(s.sop_id!==e.sop_id||s.version!==e.version||s.revision!==e.revision||!s.allowed_roles.some(r=>roles.includes(r))||!educationFields.includes(e.field))return null;
 const quote=s[e.field]?.[e.index];
 if(typeof quote!=="string"||quote!==e.quote||s.source_reference!==e.source_reference)return null;
 return {sop_id:s.sop_id,version:s.version,revision:s.revision,field:e.field,index:e.index,quote,source_reference:s.source_reference};
}
export function reviewSchedule({correct,streak,asOf}){
 const next=correct?Math.min(4,streak+1):0,days=correct?[1,3,7,14][next-1]:1;
 return {streak:next,days,due_at:new Date(Date.parse(asOf)+days*86400000).toISOString()};
}
export function learnerView(lesson,progress,asOf){
 return {lesson_id:lesson.lesson_id,title:lesson.title,category:lesson.category,scenario:lesson.scenario,objective:lesson.objective,options:lesson.options.map(({option_id,text})=>({option_id,text})),revision:lesson.revision,progress_version:progress?.version??0,due_at:progress?.due_at??null,due:!progress||progress.due_at<=asOf,practice_count:progress?.practice_count??0,reflection_prompt:lesson.reflection_prompt,training_only:true,certification:false};
}
