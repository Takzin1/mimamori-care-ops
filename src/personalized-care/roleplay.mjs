// Scripted, fictional communication training. No model, clinical assessment or operational action.
const fail=(code,status=400)=>{throw Object.assign(Error(code),{status});};
const key=x=>typeof x==="string"&&/^[A-Za-z0-9._:-]{1,64}$/.test(x);
const shape=(o,keys)=>o&&typeof o==="object"&&!Array.isArray(o)&&Object.keys(o).sort().join(",")===keys;
const text=(v,max)=>{if(typeof v!=="string"||!v.trim()||v.length>max)fail("INVALID_SIMULATION_TEXT");return v.trim();};
export function validateScenario(x){
 if(!shape(x,"lesson_id,nodes,objective,pii_reviewed,reflection_prompt,scenario_id,title")||!key(x.scenario_id)||!key(x.lesson_id)||x.pii_reviewed!==true||!Array.isArray(x.nodes)||x.nodes.length<2||x.nodes.length>6)fail("INVALID_SIMULATION");
 const nodes=x.nodes.map((n,i)=>{
  if(!shape(n,"choices,prompt")||!Array.isArray(n.choices)||n.choices.length<2||n.choices.length>4)fail("INVALID_SIMULATION_NODE");
  const choices=n.choices.map(c=>{
   if(!shape(c,"choice_id,coaching,next,reply,text")||!key(c.choice_id)||!(c.next===null||Number.isSafeInteger(c.next)&&c.next>i&&c.next<x.nodes.length))fail("INVALID_SIMULATION_BRANCH");
   return {choice_id:c.choice_id,text:text(c.text,250),reply:text(c.reply,300),coaching:text(c.coaching,350),next:c.next};
  });
  if(new Set(choices.map(c=>c.choice_id)).size!==choices.length||new Set(choices.map(c=>c.text)).size!==choices.length)fail("INVALID_SIMULATION_NODE");
  // First exchange must lead to at least one further conversation turn on every path.
  if(i===0&&choices.some(c=>c.next===null))fail("INVALID_SIMULATION_BRANCH");
  return {prompt:text(n.prompt,400),choices};
 });
 const reachable=new Set([0]);for(let i=0;i<nodes.length;i++)if(reachable.has(i))for(const c of nodes[i].choices)if(c.next!==null)reachable.add(c.next);
 if(reachable.size!==nodes.length)fail("INVALID_SIMULATION_BRANCH");
 return {scenario_id:x.scenario_id,lesson_id:x.lesson_id,title:text(x.title,100),objective:text(x.objective,250),reflection_prompt:text(x.reflection_prompt,250),nodes};
}
export function sessionView(s,session){
 const node=session.node===null?null:s.nodes[session.node];
 return {scenario_id:s.scenario_id,session_id:session.session_id,revision:s.revision,version:session.version,status:session.node===null?"COMPLETED":"IN_PROGRESS",title:s.title,objective:s.objective,transcript:session.transcript.map(({prompt,text,reply})=>({prompt,text,reply})),current:node?{prompt:node.prompt,choices:node.choices.map(({choice_id,text})=>({choice_id,text}))}:null,training_only:true,certification:false,mode:"SCRIPTED"};
}
export function nextStep(s,session,choiceId){
 const node=session.node===null?null:s.nodes[session.node],choice=node?.choices.find(c=>c.choice_id===choiceId);
 if(!choice)fail("INVALID_SIMULATION_CHOICE");
 return {...session,node:choice.next,version:session.version+1,transcript:[...session.transcript,{prompt:node.prompt,text:choice.text,reply:choice.reply,coaching:choice.coaching}]};
}
export function debrief(s,session,evidence){
 return {reflection_prompt:s.reflection_prompt,observations:session.transcript.map(({text,coaching})=>({choice:text,coaching})),evidence,training_only:true,certification:false};
}
