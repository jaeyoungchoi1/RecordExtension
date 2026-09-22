// Embedded in each standalone task HTML; no network/runtime dependencies.
let selectedAoi=null, notes={}, noteKey='jy-aoi-notes-v2-task'+DATA.task_id;
try { notes=JSON.parse(localStorage.getItem(noteKey)||'{}'); } catch (_) { notes={}; }
if(!notes || typeof notes!=='object' || Array.isArray(notes)) notes={};
function currentVariant(){return DATA.pages?.[Number($('page').value)]?.variants[Number($('basis').value)]}
function selectAoi(id){
 selectedAoi=id;const a=aois[id];if(!a)return;
 if(!currentVariant()?.anchors[id]){
  const pi=(DATA.pages||[]).findIndex(p=>p.variants.some(v=>v.anchors[id]));
  if(pi>=0){$('page').value=pi;$('page').onchange();$('basis').value=DATA.pages[pi].variants.findIndex(v=>v.anchors[id])}
 }
 $('annotationLabel').textContent=aidName(id)+' · '+a.category+(currentVariant()?.anchors[id]?'':' · No visible anchor in available mosaics; recorded provenance below.');
 $('annotation').disabled=false;$('annotation').value=notes[id]?.note||'';
 const sources=DATA.users.flatMap(u=>u.states.flatMap(s=>s.components.filter(c=>c.aoi_id===id).map(c=>({user:u.user,state:s.state_id,component:c.component_id,identity:c.identity,matching:c.matching,DOM:c.dom,A11y:c.ax}))));
 $('detail').textContent=JSON.stringify({AOI:aidName(id),statistics:a,recorded_instances:sources},null,2);
 drawMerged();showAoiTrees(id);
}
function mergedSetup(){
 $('page').innerHTML=(DATA.pages||[]).map((p,i)=>'<option value="'+i+'">'+esc(p.url)+'</option>').join('');
 function basis(){const p=DATA.pages?.[Number($('page').value)];$('basis').innerHTML=(p?.variants||[]).map((v,i)=>'<option value="'+i+'">'+esc(v.reference_user+' · '+v.document_id+' · '+v.common_count+' common AOIs')+'</option>').join('');drawMerged();trees()}
 $('page').onchange=basis;$('basis').onchange=()=>{drawMerged();if(selectedAoi)showAoiTrees(selectedAoi)};basis();
 $('saveNote').onclick=()=>{if(!selectedAoi)return;notes[selectedAoi]={note:$('annotation').value,identity:aois[selectedAoi].identity,updated_at:new Date().toISOString()};try{localStorage.setItem(noteKey,JSON.stringify(notes));$('noteStatus').textContent='Saved in this browser. Export to keep a portable copy.'}catch(_){$('noteStatus').textContent='Browser storage unavailable. Use Export to save your notes.'}};
 $('exportNotes').onclick=()=>{const blob=new Blob([JSON.stringify({task:DATA.task_id,annotations:notes},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='task'+DATA.task_id+'_annotations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
}
function drawMerged(){
 const v=currentVariant();if(!v){$('screens').innerHTML='<p class="empty">No usable reference screenshot.</p>';$('alignment').textContent='';return}
 const anchors=v.anchors, w=v.width, h=v.height, url=DATA.pages[Number($('page').value)].url;
 $('alignment').textContent=v.alignment.map(c=>c.user+': '+c.shown+'/'+c.total+' observations aligned; '+c.omitted+' omitted (unassigned or no anchor in this mosaic)').join(' · ');
 const tiles=v.tiles.map((t,i)=>'<clipPath id="tile'+i+'"><rect x="'+t.x+'" y="'+t.clip_top+'" width="'+t.width+'" height="'+(t.clip_bottom-t.clip_top)+'"/></clipPath><image href="'+esc(DATA.embedded_images?.[t.image]||t.image)+'" x="'+t.x+'" y="'+t.y+'" width="'+t.width+'" height="'+t.height+'" clip-path="url(#tile'+i+')"/>').join('');
 const boxes=Object.values(anchors).sort((a,b)=>b.width*b.height-a.width*a.height).map(a=>{
  const common=cat(a)==='common', chosen=a.aoi_id===selectedAoi;
  return '<g class="mergedAoi" data-id="'+esc(a.aoi_id)+'" tabindex="0" role="button" aria-label="'+esc(aidName(a.aoi_id))+'"><rect x="'+a.x+'" y="'+a.y+'" width="'+a.width+'" height="'+a.height+'" fill="'+(chosen?'#ffdf40':'transparent')+'" fill-opacity=".22" stroke="'+(chosen?'#d47a00':common?'#111':'#536277')+'" stroke-opacity="'+(chosen||common?'.95':'.6')+'" stroke-width="'+(chosen?4:common?2.5:1.2)+'" vector-effect="non-scaling-stroke"/><title>'+esc(aidName(a.aoi_id)+' · '+cat(a)+' · click to annotate')+'</title></g>'}).join('');
 let colored=[], black=new Map(), dots=new Map();
 DATA.users.forEach(u=>{
  const stateIds=new Set(v.alignment.find(c=>c.user===u.user)?.state_ids||[]);
  const remainingEdges=$('mode').value==='selected_projection'?DATA.edges.filter(e=>e.user===u.user&&e.mode==='direct'&&[e.from,e.to].some(id=>aois[id]?.category==='remaining'||aois[id]?.category==='unassessed')):[];
  [...edgesFor(u),...remainingEdges].filter(e=>stateIds.has(e.from_state)&&stateIds.has(e.to_state)&&!e.boundary&&anchors[e.from]&&anchors[e.to]&&visible({aoi_id:e.from})&&visible({aoi_id:e.to})).forEach(e=>{
   const a=anchors[e.from],b=anchors[e.to];
   const line='<path d="M'+a.cx+','+a.cy+' L'+b.cx+','+b.cy+'" fill="none" stroke="'+(e.common_transition?'#111':color(u.user))+'" stroke-opacity="'+(e.common_transition?'1':'.65')+'" stroke-width="'+(e.common_transition?6:3.5)+'" vector-effect="non-scaling-stroke" marker-end="url(#'+(e.common_transition?'blackArrow':'arrow'+DATA.users.indexOf(u))+')" '+(e.mode==='selected_projection'?'stroke-dasharray="12 7"':'')+'><title>'+esc(u.user+' · '+e.mode+' · '+aidName(e.from)+' → '+aidName(e.to)+'; support '+e.support_users.join(', ')+'; skipped '+e.skipped_fragments)+'</title></path>';
   if(e.common_transition)black.set(e.from+'>'+e.to,line);else colored.push(line);
  });
  u.observations.filter(o=>stateIds.has(o.state_id)&&anchors[o.aoi_id]&&visible(o)).forEach(o=>{const a=anchors[o.aoi_id],common=cat(o)==='common';dots.set((common?'common':u.user)+o.aoi_id,'<circle class="mergedAoi" data-id="'+esc(o.aoi_id)+'" cx="'+a.cx+'" cy="'+a.cy+'" r="'+(common?11:7+DATA.users.indexOf(u)*3)+'" fill="'+(common?'#111':color(u.user))+'" fill-opacity="'+(common?1:.4)+'" stroke="white" stroke-width="1"><title>'+esc(aidName(o.aoi_id))+'</title></circle>')});
 });
 const markers=[['blackArrow','#111'],...DATA.users.map((u,i)=>['arrow'+i,color(u.user)])].map(([id,c])=>'<marker id="'+id+'" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="'+c+'"/></marker>').join('');
 $('screens').innerHTML='<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Merged AOI scanpaths on '+esc(url)+'" viewBox="0 0 '+w+' '+h+'" style="display:block;width:100%;background:#e4e8ed"><defs>'+markers+'</defs>'+tiles+boxes+colored.join('')+[...black.values()].join('')+[...dots.values()].join('')+'</svg>';
 document.querySelectorAll('.mergedAoi').forEach(el=>{el.style.cursor='pointer';el.onclick=()=>selectAoi(el.dataset.id);el.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();selectAoi(el.dataset.id)}}});
}
