"use strict";
const $=id=>document.getElementById(id);
let token="",residents=[],guide=null,interactionId=null,log=null,busy=false,epoch=0;
const base="/api/personalized-care/tenants/demo/facilities/facility-1";
function message(text){$("message").textContent=text;}
function clearGuide(){epoch++;guide=null;interactionId=null;log=null;$("output").hidden=true;$("promote").hidden=true;$("result").textContent="";$("summary").value="";$("follow").checked=false;$("human").checked=false;}
function purge(){for(const id of ["steps","wishes","facts","questions","evidence","checks"])$(id).replaceChildren();$("gate").textContent="";$("version").textContent="";}
async function api(path,body){
 const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{Authorization:"Bearer "+token,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:"no-store"});
 const data=await response.json();if(!response.ok)throw Error(data.error?.code??"REQUEST_REJECTED");return data;
}
function fill(id,items){const root=$(id);root.replaceChildren();for(const text of items){const li=document.createElement("li");li.textContent=text;root.append(li);}}
function populate(){const q=$("search").value.trim();const root=$("resident");root.replaceChildren();for(const r of residents.filter(r=>(r.display_name+" "+r.room_number).includes(q))){const o=document.createElement("option");o.value=r.resident_id;o.textContent=r.display_name+" / "+r.room_number+"号室";root.append(o);}clearGuide();purge();}
async function run(fn){if(busy)return;busy=true;message("");try{await fn();}catch(e){message("操作できませんでした（"+e.message+"）。入力・権限を確認し、必要に応じガイドを再取得してください。");}finally{busy=false;}}
$("connect").onclick=()=>run(async()=>{token=$("token").value;$("token").value="";try{residents=await api("/residents");}catch(e){token="";throw e;}$("login").hidden=true;$("work").hidden=false;populate();});
$("logout").onclick=()=>{token="";residents=[];clearGuide();purge();$("work").hidden=true;$("login").hidden=false;$("resident").replaceChildren();$("search").value="";message("");};
$("search").oninput=populate;$("resident").onchange=()=>{clearGuide();purge();};$("category").onchange=$("resident").onchange;
$("guide").onclick=()=>run(async()=>{
 clearGuide();purge();const generation=epoch,r=$("resident").value,c=$("category").value;if(!r)throw Error("入居者を選択してください");
 const g=await api("/guides",{resident_id:r,category:c});if(generation!==epoch||!token)return;
 guide=g;interactionId=crypto.randomUUID();$("output").hidden=false;
 $("gate").textContent=g.blocked?"責任者への確認が必要。自動で対応を確定しません。":"本人の現在の意思を確認してから対応してください。";$("gate").dataset.blocked=String(g.blocked);
 $("version").textContent="SOP "+(g.applicable_sop??"未確定")+" / v"+(g.sop_version??"—")+"・個別情報 v"+g.resident_context_version;
 fill("steps",g.standard_steps);fill("wishes",g.personalized_considerations.map(p=>p.value));
 fill("facts",[...g.observed_facts.map(p=>"観察: "+p.value),...g.approved_constraints.map(p=>"制約: "+p.category+" / "+p.prohibited_value)]);
 fill("questions",[...g.required_confirmations,...g.unresolved_questions,...g.escalation_conditions,...g.conflicts.map(c=>"矛盾: "+c.category)]);
 fill("evidence",[...g.prohibited_actions,...g.evidence_references]);
 const root=$("checks");root.replaceChildren();for(const value of g.required_confirmations){const label=document.createElement("label"),input=document.createElement("input");input.type="checkbox";input.value=value;label.append(input,document.createTextNode(" "+value));root.append(label);}
 $("record").disabled=false;$("follow").checked=g.blocked;
});
$("record").onclick=()=>run(async()=>{
 if(!guide||log)return;const generation=epoch;const follow=$("follow").checked;if(guide.blocked&&!follow)throw Error("責任者への確認を記録してください");
 const checks=[...$("checks").querySelectorAll("input:checked")].map(x=>x.value);
 const record=await api("/interactions",{interaction_id:interactionId,resident_id:$("resident").value,interaction_type:$("category").value,sop_id:guide.applicable_sop,sop_version:guide.sop_version,resident_context_version:guide.resident_context_version,guide_token:guide.guide_token,action_summary:$("summary").value,status:follow?"FOLLOWUP":"RECORDED",followup_required:follow,human_confirmed:$("human").checked,confirmed_checks:checks});
 if(generation!==epoch||!token)return;log=record;$("record").disabled=true;$("result").textContent="記録しました。";$("promote").hidden=!follow;$("promote").disabled=false;
});
$("promote").onclick=()=>run(async()=>{if(!log)return;const generation=epoch;const result=await api("/interactions/"+encodeURIComponent(log.interaction_id)+"/promote",{expected_version:log.version,priority:"normal"});if(generation!==epoch||!token)return;$("result").textContent="Case作成: "+result.case_id+"（既存CaseのNEW状態）";$("promote").disabled=true;});
