// Lazy recorded-tree browser: only the selected ancestry/routes open initially.
function renderRecordedTree(host, rows, highlights){
 if(!rows?.length){host.innerHTML='<p class="mini">Recorded tree unavailable. Rebuild this task to include tree data.</p>';return}
 const nodes=new Map(rows.map(n=>[String(n.id),n])),children=new Map(),expanded=new Set();
 rows.forEach(n=>{const p=n.parent==null||!nodes.has(String(n.parent))?null:String(n.parent);if(!children.has(p))children.set(p,[]);children.get(p).push(String(n.id))});
 Object.keys(highlights).forEach(id=>{let seen=new Set();while(nodes.has(id)&&!seen.has(id)){seen.add(id);expanded.add(id);const p=nodes.get(id).parent;if(p==null)break;id=String(p)}});
 function branch(id,seen=new Set()){
  if(seen.has(id))return '<div>Cycle in recorded tree</div>';
  const n=nodes.get(id),kids=children.get(id)||[],hit=highlights[id],label=esc(n.label)+' <small>['+esc(id)+']</small>'+(hit?' <b>'+esc(hit.label)+'</b>':'');
  const cls=hit?hit.className:'';
  if(!kids.length)return '<div style="margin:4px 0 4px 16px" class="'+cls+'">'+label+'</div>';
  const open=expanded.has(id),next=new Set([...seen,id]);
  return '<details data-node="'+esc(id)+'" data-loaded="'+(open?'yes':'no')+'" '+(open?'open':'')+'><summary class="'+cls+'">'+label+'</summary><div class="tree-children">'+(open?kids.map(k=>branch(k,next)).join(''):'')+'</div></details>';
 }
 host.innerHTML=(children.get(null)||[]).map(id=>branch(id)).join('')||'<p>Tree root unavailable.</p>';
 function bind(){host.querySelectorAll('details[data-node]').forEach(d=>{d.ontoggle=()=>{if(d.open&&d.dataset.loaded!=='yes'){d.dataset.loaded='yes';d.querySelector('.tree-children').innerHTML=(children.get(d.dataset.node)||[]).map(k=>branch(k,new Set([d.dataset.node]))).join('');bind()}}})}
 bind();
}
let treeInstances=[];
function showAoiTrees(id){
 treeInstances=DATA.users.flatMap(u=>u.states.flatMap(s=>s.components.filter(c=>c.aoi_id===id).map(c=>({u,s,c}))));
 $('treeInstance').innerHTML=treeInstances.map((r,i)=>'<option value="'+i+'">'+esc(r.u.user+' · '+r.s.state_id+' · '+r.c.component_id)+'</option>').join('');
 const anchor=currentVariant()?.anchors[id];
 const i=treeInstances.findIndex(r=>r.u.user===DATA.users[anchor?.user_index]?.user&&r.s.state_id===anchor?.state_id&&r.c.component_id===anchor?.component_id);
 if(i>=0)$('treeInstance').value=i;
 function draw(){const r=treeInstances[Number($('treeInstance').value)];for(const [tree,host] of [['dom','domLocation'],['ax','axLocation']]){const node=r?.c[tree]?.node_id;if(node==null){$(host).innerHTML='<p class="mini">This AOI has no mapped node in this recorded tree.</p>';continue}renderRecordedTree($(host),r?.s.trees?.[tree],{[String(node)]:{label:'Selected AOI · depth '+r.c[tree].depth,className:'tree-hit'}})}}
 $('treeInstance').onchange=draw;draw();
}
function trees(){
 const page=DATA.pages?.[Number($('page').value)],stateIds=new Map(DATA.users.map(u=>[u.user,new Set((page?.variants[0]?.alignment.find(a=>a.user===u.user)?.state_ids)||[])]));
 const edges=DATA.edges.filter(e=>e.mode===$('mode').value&&!e.boundary&&aois[e.from]?.category==='common'&&aois[e.to]?.category==='common'&&(!page||stateIds.get(e.user)?.has(e.from_state)));
 $('jumpSelect').innerHTML=edges.map((e,i)=>'<option value="'+i+'">'+esc(e.user+' · '+e.from_state+' · '+short[e.from]+' → '+short[e.to]+(e.common_transition?' · shared by all':' · individual order'))+'</option>').join('');
 function draw(){
  const e=edges[Number($('jumpSelect').value)];
  if(!e){$('jumpSummary').textContent='No eligible transition between common AOIs on this page in this mode.';$('domJump').innerHTML=$('axJump').innerHTML='';return}
  const u=DATA.users.find(u=>u.user===e.user),s=u.states.find(s=>s.state_id===e.from_state);
  $('jumpSummary').innerHTML='<b>'+esc(aidName(e.from))+' → '+esc(aidName(e.to))+'</b><br>'+esc(e.user+' · '+e.from_state)+' · '+(e.common_transition?'Directed transition shared by all users.':'Common endpoints; this ordering is not shared by all users.')+'<br>'+['dom','ax'].map(t=>{const j=e[t];return '<b>'+t.toUpperCase()+':</b> '+(j.available?'source depth '+j.from_depth+' ('+(j.from_leaf?'leaf':'non-leaf')+') ↑ '+j.up+' to LCA depth '+j.lca_depth+' ↓ '+j.down+' to destination depth '+j.to_depth+' ('+(j.to_leaf?'leaf':'non-leaf')+'). Distance = '+j.up+' + '+j.down+' = '+j.distance+' tree edges.':'Unavailable: '+esc(j.reason))}).join('<br>')+'<br><small>Root depth = 0. Orange = source; blue = destination; green = LCA. '+(e.mode==='selected_projection'?'Projected order, skipping '+e.skipped_fragments+' observations; not necessarily one saccade.':'Consecutive observed AOIs.')+'</small>';
  for(const [t,host] of [['dom','domJump'],['ax','axJump']]){
   const a=u.observations[e.from_index]?.[t],b=u.observations[e.to_index]?.[t],j=e[t],highlights={};
   if(j.available){
    for(const node of (a?.ancestors||[]).slice(1,j.up))highlights[String(node)]={label:'↑ toward LCA',className:'tree-from'};
    for(const node of (b?.ancestors||[]).slice(1,j.down))highlights[String(node)]={label:'↓ toward destination',className:'tree-to'};
   }
   if(a?.node_id!=null)highlights[String(a.node_id)]={label:'FROM · depth '+a.depth,className:'tree-from tree-hit'};
   if(b?.node_id!=null)highlights[String(b.node_id)]={label:'TO · depth '+b.depth,className:'tree-to tree-hit'};
   if(j.available){const id=String(j.lca_id);highlights[id]={label:'LCA · depth '+j.lca_depth+(highlights[id]?' · '+highlights[id].label:''),className:'tree-lca'}}
   renderRecordedTree($(host),s?.trees?.[t],highlights);
  }
 }
 $('jumpSelect').onchange=draw;draw();
}
