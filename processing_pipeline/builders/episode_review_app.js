(() => {
  const data = window.EPISODE_REVIEW_DATA;
  const states = Object.fromEntries(data.states.map(s => [s.state_id, s]));
  const params = new URLSearchParams(location.search);
  const coderId = params.get('coder') || 'default';
  const readOnly = params.get('readonly') === '1';
  const baseStorageKey = `episode-review:${data.task.task_id}`;
  const storageKey = coderId === 'default' ? baseStorageKey : `${baseStorageKey}:coder:${coderId}`;
  let episodes = JSON.parse(localStorage.getItem(`${storageKey}:episodes`) || 'null') || structuredClone(data.episodes);
  let annotations = JSON.parse(localStorage.getItem(`${storageKey}:annotations`) || '{}');
  let episodeIndex = 0, activeStateId = '', activeVisit = null;
  const $ = id => document.getElementById(id);

  const taskSelect = $('taskSelect');
  Array.from({length:31},(_,index)=>String(index+1).padStart(2,'0')).forEach(id => taskSelect.add(new Option(`Task ${id}`, id)));
  taskSelect.value = data.task.task_id;
  taskSelect.onchange = () => {const next=new URLSearchParams();if(coderId!=='default')next.set('coder',coderId);if(readOnly)next.set('readonly','1');location.href=`task${taskSelect.value}.html${next.toString()?`?${next}`:''}`;};
  const fillSelect = (el, values) => values.forEach(v => el.add(new Option(v || '—', v)));
  fillSelect($('visualPattern'), data.coding.visual); fillSelect($('treePattern'), data.coding.tree); fillSelect($('outcome'), data.coding.outcomes);
  data.coding.contexts.forEach(v => $('contextChecks').insertAdjacentHTML('beforeend', `<label><input type=checkbox value="${v}"> ${v}</label>`));
  $('taskTitle').textContent = `Task ${data.task.task_id} · ${data.task.title}`;
  $('prompt').textContent = data.task.prompt;
  if(readOnly){$('annotationPanel').style.display='none';document.querySelector('.episode-tools').style.display='none';}

  function saveEpisodes(){ localStorage.setItem(`${storageKey}:episodes`, JSON.stringify(episodes)); }
  function saveAnnotation(){
    const ep = episodes[episodeIndex];
    annotations[ep.episode_id] = {
      task_id:data.task.task_id, episode_id:ep.episode_id, state_ids:ep.state_ids,
      visual_pattern:$('visualPattern').value, tree_pattern:$('treePattern').value,
      outcome:$('outcome').value, workflow_context:[...$('contextChecks').querySelectorAll('input:checked')].map(x=>x.value),
      confidence:$('confidence').value, notes:$('notes').value,
      suggested_labels:ep.suggestions, updated_at:new Date().toISOString()
    };
    localStorage.setItem(`${storageKey}:annotations`, JSON.stringify(annotations));
  }
  ['visualPattern','treePattern','outcome','confidence','notes'].forEach(id => $(id).addEventListener('change', saveAnnotation));
  $('contextChecks').addEventListener('change', saveAnnotation);
  $('treeMode').addEventListener('change',()=>{if(activeStateId && states[activeStateId])renderTree(states[activeStateId]);});

  function renderEpisodeOptions(){
    const sel=$('episodeSelect'); sel.innerHTML='';
    episodes.forEach((e,i)=>sel.add(new Option(`${e.episode_id} · ${e.title}`,i)));
    sel.value=episodeIndex; sel.onchange=()=>{episodeIndex=Number(sel.value); renderEpisode();};
  }
  function annotationFor(ep){ return annotations[ep.episode_id] || {}; }
  function renderEpisode(){
    const ep=episodes[episodeIndex]; const ann=annotationFor(ep);
    $('episodeSelect').value=episodeIndex;
    $('taskMeta').textContent=`${ep.episode_id} · ${ep.start_s.toFixed(3)}–${ep.end_s.toFixed(3)} s · boundary: ${ep.boundary} · outcome: ${data.task.outcome_status} · coder: ${coderId}`;
    $('warning').style.display=ep.source_warning?'block':'none'; $('warning').textContent=ep.source_warning||'';
    $('stateTabs').innerHTML='';
    ep.state_ids.forEach(id=>{const b=document.createElement('button');b.className='state-tab';b.textContent=id;b.onclick=()=>selectState(id);$('stateTabs').appendChild(b);});
    if(ep.result_state_id && states[ep.result_state_id]){const b=document.createElement('button');b.className='state-tab';b.textContent=`result · ${ep.result_state_id}`;b.onclick=()=>selectState(ep.result_state_id);$('stateTabs').appendChild(b);}
    $('suggestions').innerHTML='<strong>Suggested from evidence</strong><br>'+(ep.suggestions.length?ep.suggestions.map(s=>`<button class=suggestion data-label="${s.label}">${s.label}<small>${s.why}</small></button>`).join(''):'<span class=muted>No automatic suggestion</span>');
    $('suggestions').querySelectorAll('.suggestion').forEach(b=>b.onclick=()=>applySuggestion(b.dataset.label));
    $('visualPattern').value=ann.visual_pattern||''; $('treePattern').value=ann.tree_pattern||''; $('outcome').value=ann.outcome||''; $('confidence').value=ann.confidence||''; $('notes').value=ann.notes||'';
    $('contextChecks').querySelectorAll('input').forEach(c=>c.checked=(ann.workflow_context||[]).includes(c.value));
    selectState(ep.state_ids[0]);
  }
  function applySuggestion(label){
    if(data.coding.visual.includes(label)) $('visualPattern').value=label;
    else if(data.coding.tree.includes(label)) $('treePattern').value=label;
    else { const cb=[...$('contextChecks').querySelectorAll('input')].find(x=>x.value===label); if(cb) cb.checked=true; }
    saveAnnotation();
  }
  function selectState(id){
    activeStateId=id; activeVisit=null;
    $('stateTabs').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.textContent.endsWith(id)));
    const state=states[id]; if(!state) return;
    const ep=episodes[episodeIndex];
    if(ep.suppress_state_evidence){
      $('screenImage').removeAttribute('src'); $('screenImage').alt='No aligned screenshot captured';
      $('screenOverlay').innerHTML='';
      $('treeMeta').textContent='Aligned accessibility tree unavailable';
      $('movementSummary').textContent='Tree movement cannot be coded from this recording';
      $('axTree').innerHTML='<div class=empty>No Booking.com accessibility-tree snapshot was captured.</div>';
      $('visitList').innerHTML='<div class=empty>No component visits are shown because the available gaze cannot be aligned to a captured Booking.com state.</div>';
      renderActions(state, ep.actions || []);
      return;
    }
    $('screenImage').src=state.image; $('screenImage').alt=`${id} screenshot`;
    $('treeMeta').textContent=`${id}${state.document_reset?' · new document/tree':''}`;
    $('movementSummary').textContent=state.tree_movements.join(' · ')||'No mapped tree transition';
    renderOverlay(state); renderTree(state); renderVisits(state); renderActions(state);
  }
  function renderOverlay(state){
    const svg=$('screenOverlay'); svg.setAttribute('viewBox',`0 0 ${state.image_width} ${state.image_height}`); svg.setAttribute('width',state.image_width); svg.setAttribute('height',state.image_height); svg.innerHTML='<defs><marker id=arrow markerWidth=5 markerHeight=5 refX=4.5 refY=2.5 orient=auto><path d="M0,0 L0,5 L5,2.5 z" fill="#ed1c24"/></marker></defs>';
    state.components.forEach(c=>{const r=document.createElementNS('http://www.w3.org/2000/svg','rect');r.setAttribute('x',c.x);r.setAttribute('y',c.y);r.setAttribute('width',c.width);r.setAttribute('height',c.height);r.setAttribute('class',`component-box ${c.noisy?'noisy':''} ${state.visits.some(v=>v.component_id===c.component_id)?'visited':''}`);r.dataset.component=c.component_id;r.addEventListener('pointerenter',()=>highlight(c.component_id));r.addEventListener('click',()=>highlight(c.component_id));svg.appendChild(r);});
    for(let i=0;i<state.visits.length-1;i++){const a=state.visits[i],b=state.visits[i+1];const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',a.centroid_x);line.setAttribute('y1',a.centroid_y);line.setAttribute('x2',b.centroid_x);line.setAttribute('y2',b.centroid_y);line.setAttribute('class','gaze-line');svg.appendChild(line);}
    state.visits.forEach(v=>{const g=document.createElementNS('http://www.w3.org/2000/svg','g');g.dataset.component=v.component_id;g.addEventListener('pointerenter',()=>highlight(v.component_id,v.visit_order));const c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx',v.centroid_x);c.setAttribute('cy',v.centroid_y);c.setAttribute('r',18);c.setAttribute('class','gaze-dot');const t=document.createElementNS('http://www.w3.org/2000/svg','text');t.setAttribute('x',v.centroid_x);t.setAttribute('y',v.centroid_y);t.setAttribute('class','gaze-number');t.textContent=v.visit_order;g.append(c,t);svg.appendChild(g);});
    $('boxesToggle').onchange=e=>svg.querySelectorAll('.component-box').forEach(x=>x.classList.toggle('hidden-layer',!e.target.checked));
    $('gazeToggle').onchange=e=>svg.querySelectorAll('.gaze-line,.gaze-dot,.gaze-number').forEach(x=>x.classList.toggle('hidden-layer',!e.target.checked));
  }
  function renderTree(state){
    const root=$('axTree');root.innerHTML='';
    if(!state.ax_tree.length){root.innerHTML='<div class=empty>No accessibility tree captured.</div>';return;}
    let rows=state.ax_tree;
    if($('treeMode').value==='visited'){
      const keep=new Set(),ancestors=[];
      rows.forEach((node,index)=>{ancestors.length=node.depth;ancestors[node.depth]=index;if(node.visited.length){keep.add(index);ancestors.forEach(i=>keep.add(i));}});
      rows=rows.filter((_,index)=>keep.has(index));
      if(!rows.length){root.innerHTML='<div class=empty>No retained visit maps to this accessibility tree. Switch to Full tree to inspect the raw structure.</div>';return;}
    }
    rows.forEach(n=>{const row=document.createElement('div');row.className=`ax-row ${n.visited.length?'visited':''}`;row.style.paddingLeft=`${8+n.depth*15}px`;row.dataset.components=n.component_ids;row.dataset.node=n.node_id;row.innerHTML=`<span class=ax-order>${n.visited.map(x=>'#'+x).join(' ')}</span><span class=ax-role>${escapeHtml(n.role||'—')}</span><span class=ax-name>${escapeHtml(n.name||'(unnamed)')}</span>`;row.onclick=()=>{const c=(n.component_ids||'').split(' ')[0];if(c)highlight(c,n.visited[0]);};root.appendChild(row);});
  }
  function renderVisits(state){
    const root=$('visitList');root.innerHTML=state.visits.length?'':'<div class=empty>No retained visit (minimum 100 ms).</div>';
    state.visits.forEach(v=>{const row=document.createElement('div');row.className='visit-row';row.dataset.component=v.component_id;row.dataset.visit=v.visit_order;row.innerHTML=`<span class=visit-id>#${v.visit_order}</span><span>${escapeHtml(v.semantic_name)}<br><span class=muted>${v.component_id} · ${escapeHtml(v.ax_role||'Unmapped')} · depth ${v.ax_depth??'—'}</span></span><span>${v.duration_s.toFixed(3)} s</span><span>${v.time_s.toFixed(3)} s</span>`;row.onmouseenter=()=>highlight(v.component_id,v.visit_order);root.appendChild(row);});
  }
  function renderActions(state, actions=state.actions){$('actionList').innerHTML=actions.length?actions.map(a=>`<div class=action-row><span>${a.time_s}</span><strong>${escapeHtml(a.type)}</strong><span>${escapeHtml(a.target)}</span></div>`).join(''):'<div class=empty>No recorded action in this state.</div>';}
  function highlight(componentId,visitOrder){
    activeVisit=visitOrder||null;
    document.querySelectorAll('.active').forEach(x=>{if(!x.classList.contains('state-tab'))x.classList.remove('active');});
    document.querySelectorAll(`[data-component~="${CSS.escape(componentId)}"]`).forEach(x=>x.classList.add('active'));
    if(visitOrder) document.querySelectorAll(`[data-visit="${visitOrder}"]`).forEach(x=>x.classList.add('active'));
  }
  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

  $('prevBtn').onclick=()=>{if(episodeIndex>0){episodeIndex--;renderEpisode();}};
  $('nextBtn').onclick=()=>{if(episodeIndex<episodes.length-1){episodeIndex++;renderEpisode();}};
  $('mergeBtn').onclick=()=>{if(episodeIndex>=episodes.length-1)return;const a=episodes[episodeIndex],b=episodes[episodeIndex+1];a.state_ids=[...new Set([...a.state_ids,...b.state_ids])];a.end_s=b.end_s;a.result_state_id=b.result_state_id;a.title=`${a.title} + ${b.title}`;a.suggestions=[...a.suggestions,...b.suggestions].filter((x,i,arr)=>arr.findIndex(y=>y.label===x.label)===i);episodes.splice(episodeIndex+1,1);episodes.forEach((e,i)=>e.episode_id=`E${String(i+1).padStart(2,'0')}`);saveEpisodes();renderEpisodeOptions();renderEpisode();};
  $('splitBtn').onclick=()=>{const ep=episodes[episodeIndex];if(ep.state_ids.length<2){alert('Select a merged episode with at least two states.');return;}const at=ep.state_ids.indexOf(activeStateId);if(at<0||at===ep.state_ids.length-1){alert('Select a state before the final state as the split point.');return;}const second={...structuredClone(ep),state_ids:ep.state_ids.slice(at+1),start_s:states[ep.state_ids[at+1]].start_s,title:`Split · ${states[ep.state_ids[at+1]].title||ep.title}`};ep.state_ids=ep.state_ids.slice(0,at+1);ep.end_s=states[ep.state_ids.at(-1)].end_s;episodes.splice(episodeIndex+1,0,second);episodes.forEach((e,i)=>e.episode_id=`E${String(i+1).padStart(2,'0')}`);saveEpisodes();renderEpisodeOptions();renderEpisode();};
  $('exportBtn').onclick=()=>{saveAnnotation();const rows=Object.values(annotations);const payload={coder_id:coderId,task:data.task,episodes,annotations:rows};const coderFile=coderId.replace(/[^a-z0-9_-]+/gi,'_');download(`task${data.task.task_id}_${coderFile}_annotations.json`,JSON.stringify(payload,null,2),'application/json');const fields=['task_id','episode_id','state_ids','visual_pattern','tree_pattern','outcome','workflow_context','confidence','notes'];const csv=[fields.join(','),...rows.map(r=>fields.map(f=>`"${String(Array.isArray(r[f])?r[f].join('|'):(r[f]??'')).replaceAll('"','""')}"`).join(','))].join('\n');download(`task${data.task.task_id}_${coderFile}_annotations.csv`,csv,'text/csv');};
  function download(name,text,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  const requestedEpisode=params.get('episode');
  if(requestedEpisode){const requestedIndex=episodes.findIndex(ep=>ep.episode_id===requestedEpisode);if(requestedIndex>=0)episodeIndex=requestedIndex;}
  renderEpisodeOptions();renderEpisode();
})();
