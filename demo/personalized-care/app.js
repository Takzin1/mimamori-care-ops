"use strict";
const $=id=>document.getElementById(id);
let token="",residents=[],guide=null,interactionId=null,log=null,busy=false,epoch=0,operator=null,currentChoice=null,sessionEpoch=0;
const base="/api/personalized-care/tenants/demo/facilities/facility-1";
function message(text){$("message").textContent=text;}
function clearGuide(){epoch++;guide=null;currentChoice=null;interactionId=null;log=null;$("output").hidden=true;$("promote").hidden=true;$("result").textContent="";$("summary").value="";$("follow").checked=false;$("human").checked=false;}
function purge(){for(const id of ["steps","wishes","facts","questions","evidence","checks"])$(id).replaceChildren();$("gate").textContent="";$("version").textContent="";}
async function api(path,body){
 const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{Authorization:"Bearer "+token,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:"no-store"});
 const data=await response.json();if(!response.ok)throw Error(data.error?.code??"REQUEST_REJECTED");return data;
}
function fill(id,items){const root=$(id);root.replaceChildren();for(const text of items){const li=document.createElement("li");li.textContent=text;root.append(li);}}
function populate(){const q=$("search").value.trim();const root=$("resident");root.replaceChildren();for(const r of residents.filter(r=>(r.display_name+" "+r.room_number).includes(q))){const o=document.createElement("option");o.value=r.resident_id;o.textContent=r.display_name+" / "+r.room_number+"号室";root.append(o);}clearGuide();purge();}
async function run(fn){if(busy)return;busy=true;message("");try{await fn();}catch(e){message("操作できませんでした（"+e.message+"）。入力・権限を確認し、必要に応じガイドを再取得してください。");}finally{busy=false;}}
$("connect").onclick=()=>run(async()=>{token=$("token").value;$("token").value="";try{operator=await api("/operator");residents=await api("/residents");}catch(e){token="";operator=null;throw e;}$("login").hidden=true;$("work").hidden=false;populate();$("knowledge-coverage").hidden=!operator.can_review;$("storage-mode").textContent=operator.synthetic_persistence?"合成データ保存モード（Case昇格不可）":"合成データ・メモリモード";await refreshFollowups();});
$("logout").onclick=()=>{clearKnowledge();$("knowledge-query").value="";$("knowledge-coverage-results").replaceChildren();$("knowledge-coverage").hidden=true;sessionEpoch++;token="";operator=null;residents=[];$("followup-items").replaceChildren();$("queue-status").textContent="";$("storage-mode").textContent="";$("choice-category").value="";$("choice-value").value="";clearGuide();purge();$("work").hidden=true;$("login").hidden=false;$("resident").replaceChildren();$("search").value="";message("");};
function resetChoice(){$("choice-category").value="";$("choice-value").value="";}
const oldPopulate=populate;$("search").oninput=()=>{resetChoice();oldPopulate();};$("resident").onchange=()=>{resetChoice();clearGuide();purge();};$("category").onchange=$("resident").onchange;
$("choice-category").onchange=()=>{clearGuide();purge();};$("choice-value").oninput=()=>{clearGuide();purge();};
$("guide").onclick=()=>run(async()=>{
 clearGuide();purge();const generation=epoch,r=$("resident").value,c=$("category").value;if(!r)throw Error("入居者を選択してください");
 const key=$("choice-category").value, value=$("choice-value").value.trim();if(!!key!==!!value)throw Error("現在の希望は項目と内容の両方を入力してください");
 const choice=key?{category:key,value}:null;
 const g=await api("/guides",{resident_id:r,category:c,current_choice:choice});if(generation!==epoch||!token)return;
 guide=g;currentChoice=choice;interactionId=crypto.randomUUID();$("output").hidden=false;
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
 const record=await api("/interactions",{interaction_id:interactionId,resident_id:$("resident").value,interaction_type:$("category").value,sop_id:guide.applicable_sop,sop_version:guide.sop_version,resident_context_version:guide.resident_context_version,guide_token:guide.guide_token,current_choice:currentChoice,action_summary:$("summary").value,status:follow?"FOLLOWUP":"RECORDED",followup_required:follow,human_confirmed:$("human").checked,confirmed_checks:checks});
 if(generation!==epoch||!token)return;log=record;$("record").disabled=true;$("result").textContent="記録しました。";$("promote").hidden=!follow||!operator?.can_attempt_promotion;$("promote").disabled=false;await refreshFollowups();
});
$("promote").onclick=()=>run(async()=>{if(!log)return;const generation=epoch;const result=await api("/interactions/"+encodeURIComponent(log.interaction_id)+"/promote",{expected_version:log.version,priority:"normal"});if(generation!==epoch||!token)return;$("result").textContent="Case作成: "+result.case_id+"（既存CaseのNEW状態）";$("promote").disabled=true;await refreshFollowups();});

const reviewLabels={CONTINUE_FOLLOWUP:"継続確認",REQUEST_CASE:"Case対応が必要",NO_FURTHER_ACTION:"追加対応なし"};
function renderFollowups(items){
 const root=$("followup-items");root.replaceChildren();$("queue-status").textContent=items.length+"件の継続対応";
 for(const item of items){
  const card=document.createElement("div");card.className="followup-card";
  const heading=document.createElement("h3"),resident=residents.find(r=>r.resident_id===item.resident_id);heading.textContent=(resident?.display_name??"入居者")+" / "+(item.case_linked?"Case連携済み":item.blocked?"責任者確認が必要":item.review?reviewLabels[item.review.decision]:"未確認");card.append(heading);
  const summary=document.createElement("p");summary.textContent=item.action_summary;card.append(summary);
  if(item.review){const p=document.createElement("p");p.textContent="確認結果："+reviewLabels[item.review.decision]+" / "+item.review.reason;card.append(p);}
  if(operator?.can_review&&!item.case_linked){
   const select=document.createElement("select");select.setAttribute("aria-label","確認結果");for(const [key,label] of Object.entries(reviewLabels)){if(item.blocked&&key==="NO_FURTHER_ACTION")continue;const option=document.createElement("option");option.value=key;option.textContent=label;select.append(option);}
   const reason=document.createElement("textarea");reason.maxLength=500;reason.rows=2;reason.placeholder="確認した内容・理由（架空情報）";reason.setAttribute("aria-label","確認理由");
   const check=document.createElement("input");check.type="checkbox";const confirm=document.createElement("label");confirm.append(check,document.createTextNode(" 責任者として確認した"));
   const save=document.createElement("button");save.className="quiet";save.textContent="確認結果を保存";
   save.onclick=()=>run(async()=>{if(!check.checked||!reason.value.trim())throw Error("確認と理由を入力してください");const generation=sessionEpoch;await api("/interactions/"+encodeURIComponent(item.interaction_id)+"/review",{expected_version:item.version,decision:select.value,reason:reason.value,human_confirmed:true});if(generation!==sessionEpoch||!token)return;clearGuide();purge();await refreshFollowups();});
   card.append(select,reason,confirm,save);
  }
  root.append(card);
 }
}
async function refreshFollowups(){
 const generation=sessionEpoch,items=await api("/followups");
 if(generation!==sessionEpoch||!token)return;
 renderFollowups(items);
}
$("refresh-followups").onclick=()=>run(refreshFollowups);

let knowledgeEpoch=0;
function clearKnowledge(){knowledgeEpoch++;$("knowledge-results").replaceChildren();$("knowledge-status").textContent="";}
$("knowledge-query").oninput=clearKnowledge;$("knowledge-category").onchange=clearKnowledge;
$("knowledge-search").onclick=()=>run(async()=>{
 clearKnowledge();const gen=knowledgeEpoch,session=sessionEpoch;
 const query=$("knowledge-query").value.trim(),category=$("knowledge-category").value;
 if(!query)throw Error("キーワードを入力してください");
 const data=await api("/knowledge-search",{category,query});
 if(gen!==knowledgeEpoch||session!==sessionEpoch||!token)return;
 const messages={EVIDENCE_FOUND:"承認済み原文です。本人の希望と施設の最新手順を確認してください。",NO_MATCH:"該当なし。別のキーワードまたは責任者に確認してください。",QUERY_TOO_SHORT:"2文字以上のキーワードを入力してください。",CONSULT_REQUIRED:"検索結果で判断せず、施設の既定手順・責任者に確認してください。",UNAVAILABLE:"利用可能な承認済み手順書がありません。"};
 $("knowledge-status").textContent=messages[data.state]??"確認が必要です。";
 for(const hit of data.results){const card=document.createElement("div");card.className="knowledge-card";
  const title=document.createElement("h3");title.textContent=hit.title+" / "+hit.label+" / "+(hit.match_type==="EXACT"?"語句一致":"部分一致");
  const quote=document.createElement("blockquote");quote.textContent=hit.quote;
  const source=document.createElement("p");source.textContent="出典: "+hit.source_reference+" / v"+hit.version+"・改訂"+hit.revision+" / "+hit.evidence_id;
  card.append(title,quote,source);$("knowledge-results").append(card);}
});
$("knowledge-coverage").onclick=()=>run(async()=>{
 const gen=sessionEpoch,data=await api("/knowledge-coverage");if(gen!==sessionEpoch||!token)return;
 const labels={AVAILABLE:"承認済み・閲覧可",UNAVAILABLE:"利用可能な手順なし",AMBIGUOUS:"複数の承認済み手順・要確認"};
 fill("knowledge-coverage-results",data.map(x=>{const option=[...$("knowledge-category").options].find(o=>o.value===x.category);return (option?.textContent??x.category)+"： "+labels[x.state]+(x.version?" (v"+x.version+")":"");}));
});
