(() => {
  const data = window.CODING_PORTAL_DATA;
  if (!data || !Array.isArray(data.samples)) throw new Error('Coding portal data is unavailable.');
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const coderId = (params.get('coder') || 'UNASSIGNED').trim();
  const storageKey = `episode-coding-portal:${coderId}`;
  const fields = ['sample_id','task_id','episode_id','primary_behavior','secondary_behavior','ax_projection','outcome','modifiers','confidence','evidence','needs_human_review','notes'];
  const required = ['primary_behavior','ax_projection','outcome','confidence','evidence','needs_human_review'];
  let annotations = JSON.parse(localStorage.getItem(storageKey) || '{}');
  let index = Math.max(0, data.samples.findIndex(row => row.sample.sample_id === params.get('sample')));
  let saveTimer = null;

  const behaviorCodes = data.codebook.dimensions.observed_behavior;
  const axCodes = data.codebook.dimensions.ax_projection;
  const outcomes = data.codebook.dimensions.episode_outcome;
  const modifiers = data.codebook.dimensions.evidence_modifiers;

  function addOptions(select, rows, includeAbstain=false) {
    select.innerHTML = '<option value=""></option>';
    rows.forEach(row => select.add(new Option(`${row.code} · ${row.name}`, row.code)));
    if (includeAbstain) select.add(new Option('ABSTAIN · insufficient or unreliable evidence', 'ABSTAIN'));
  }
  addOptions($('primaryBehavior'), behaviorCodes, true);
  addOptions($('secondaryBehavior'), behaviorCodes);
  addOptions($('axProjection'), axCodes);
  addOptions($('outcome'), outcomes);
  modifiers.forEach(value => $('modifiers').insertAdjacentHTML('beforeend', `<label><input type="checkbox" value="${escapeHtml(value)}"> ${escapeHtml(value)}</label>`));
  $('coderBadge').textContent = `Coder ${coderId}`;
  if (coderId === 'UNASSIGNED') $('coderBadge').title = 'Open with ?coder=A or ?coder=B before coding.';

  function blank(row) {
    return {sample_id:row.sample.sample_id,task_id:row.sample.task_id,episode_id:row.sample.episode_id,primary_behavior:'',secondary_behavior:'',ax_projection:'',outcome:'',modifiers:[],confidence:'',evidence:'',needs_human_review:'',notes:''};
  }
  function annotation(row=data.samples[index]) { return annotations[row.sample.sample_id] || blank(row); }
  function isComplete(value) { return required.every(field => String(value[field] ?? '').trim()); }
  function save() {
    const row=data.samples[index], value=annotation(row);
    Object.assign(value, {
      primary_behavior:$('primaryBehavior').value,
      secondary_behavior:$('secondaryBehavior').value,
      ax_projection:$('axProjection').value,
      outcome:$('outcome').value,
      modifiers:[...$('modifiers').querySelectorAll('input:checked')].map(input=>input.value),
      confidence:$('confidence').value,
      evidence:$('evidenceNote').value.trim(),
      needs_human_review:$('needsReview').value,
      notes:$('notes').value.trim(),
      updated_at:new Date().toISOString(),
    });
    annotations[row.sample.sample_id]=value;
    localStorage.setItem(storageKey,JSON.stringify(annotations));
    $('saveStatus').textContent=`Saved ${row.sample.sample_id}${isComplete(value)?' · complete':' · incomplete'}`;
    renderNavigation();renderProgress();
  }

  function render() {
    const row=data.samples[index], sample=row.sample, packet=row.packet, value=annotation(row);
    $('sampleSelect').value=sample.sample_id;
    $('episodeTitle').textContent=`${sample.sample_id} · Task ${sample.task_id} · ${sample.episode_id} · ${packet.task.title}`;
    $('episodeMeta').textContent=`${packet.episode.start_s.toFixed(3)}–${packet.episode.end_s.toFixed(3)} s · ${packet.episode.boundary} · ${sample.website_domain} · ${sample.task_intent_provisional}/${sample.specificity_provisional}`;
    $('taskPrompt').textContent=packet.task.prompt;
    $('sourceWarning').style.display=packet.episode.source_warning?'block':'none';
    $('sourceWarning').textContent=packet.episode.source_warning||'';
    $('visualReview').href=`../../episode_review/task${sample.task_id}.html?episode=${encodeURIComponent(sample.episode_id)}&coder=${encodeURIComponent(coderId)}&readonly=1`;
    $('sourceEvidence').innerHTML=packet.states.length?packet.states.map(renderState).join(''):`<p class="empty">No aligned screenshot, visit, or AX state. Use action evidence and the source warning only.</p>${renderActions(packet.episode.actions)}`;
    $('resultEvidence').innerHTML=packet.result_state?`${renderTransition(packet.transition)}${renderState(packet.result_state,true)}`:'<p class="empty">No linked result state.</p>';
    $('adjacentContext').innerHTML=packet.adjacent_context.length?packet.adjacent_context.map(renderContext).join(''):'<p class="empty">No bounded adjacent context.</p>';
    $('constraints').innerHTML=packet.interpretation_constraints.map(text=>`<li>${escapeHtml(text)}</li>`).join('');
    $('primaryBehavior').value=value.primary_behavior||'';$('secondaryBehavior').value=value.secondary_behavior||'';$('axProjection').value=value.ax_projection||'';$('outcome').value=value.outcome||'';$('confidence').value=value.confidence||'';$('needsReview').value=String(value.needs_human_review??'');$('evidenceNote').value=value.evidence||'';$('notes').value=value.notes||'';
    $('modifiers').querySelectorAll('input').forEach(input=>input.checked=(value.modifiers||[]).includes(input.value));
    $('saveStatus').textContent=isComplete(value)?`${sample.sample_id} complete`:`${sample.sample_id} incomplete`;
    renderNavigation();renderProgress();
  }

  function renderState(state,post=false) {
    const visits=state.visits.filter(visit=>!visit.noisy);
    return `<article class="state-card"><strong>${post?'After action · ':''}${escapeHtml(state.state_id)} · ${escapeHtml(state.title||'(untitled)')}</strong><small>${escapeHtml(state.url||'')} ${state.document_reset?'· document/AX reset':''}</small><small>Tree: ${escapeHtml((state.tree_movements||[]).join(' · ')||'no mapped movement')}</small>${renderVisits(visits)}${renderActions(state.actions)}</article>`;
  }
  function renderVisits(visits) {
    if(!visits.length)return '<p class="empty">No retained non-noisy visit.</p>';
    return `<ol class="evidence-list">${visits.map(v=>`<li>#${v.order} ${escapeHtml(v.semantic_name)} · ${Number(v.duration_s).toFixed(3)} s · ${escapeHtml(v.ax_role||'unmapped')} · depth ${v.ax_depth??'—'}</li>`).join('')}</ol>`;
  }
  function renderActions(actions=[]) {
    if(!actions.length)return '<p class="empty">No recorded action.</p>';
    return `<ul class="evidence-list">${actions.map(a=>`<li>${escapeHtml(a.type)} · ${escapeHtml(a.target)}${a.time_s!==''&&a.time_s!==undefined?` · ${escapeHtml(a.time_s)} s`:''}</li>`).join('')}</ul>`;
  }
  function renderTransition(value) {
    if(!value)return '';
    return `<p class="transition">URL changed: ${value.url_changed}; title changed: ${value.title_changed}; document reset: ${value.document_reset}; mapped post-action visits: ${value.post_action_mapped_visit_count}</p>`;
  }
  function renderContext(context) {
    const routes=context.route.map(route=>`<div><small>${escapeHtml(route.state_id)} · ${escapeHtml(route.title||'(untitled)')} ${route.document_reset?'· reset':''}</small>${route.non_noisy_visits.length?`<ul class="evidence-list">${route.non_noisy_visits.map(v=>`<li>${escapeHtml(v)}</li>`).join('')}</ul>`:''}${renderActions(route.actions)}</div>`).join('');
    return `<article class="context-card"><strong>${escapeHtml(context.relation)} · ${escapeHtml(context.episode_id)} · ${escapeHtml(context.title)}</strong><small>${context.start_s.toFixed(3)}–${context.end_s.toFixed(3)} s · ${escapeHtml(context.boundary)}</small>${routes}</article>`;
  }

  function renderNavigation() {
    $('sampleSelect').innerHTML='';
    data.samples.forEach((row,i)=>{const value=annotation(row),label=`${row.sample.sample_id} · ${row.sample.task_id}:${row.sample.episode_id} · ${isComplete(value)?'complete':'incomplete'}`;$('sampleSelect').add(new Option(label,row.sample.sample_id));});
    $('sampleSelect').value=data.samples[index].sample.sample_id;
    $('sampleList').innerHTML='';
    data.samples.forEach((row,i)=>{const value=annotation(row);if($('incompleteOnly').checked&&isComplete(value))return;const button=document.createElement('button');button.className=`sample-item ${i===index?'current':''} ${isComplete(value)?'complete':''}`;button.innerHTML=`<strong>${escapeHtml(row.sample.sample_id)}</strong><span>${escapeHtml(row.sample.task_id+':'+row.sample.episode_id)}</span><span class="mark">${isComplete(value)?'✓':'·'}</span>`;button.onclick=()=>{save();index=i;render();};$('sampleList').appendChild(button);});
  }
  function renderProgress() { const complete=data.samples.filter(row=>isComplete(annotation(row))).length;$('progress').textContent=`${complete} / ${data.samples.length} complete`; }

  function codebookReference() {
    const entries=[...behaviorCodes,...axCodes,...outcomes];
    $('codebookReference').innerHTML=entries.map(code=>`<article class="code-entry"><h4>${escapeHtml(code.code)} · ${escapeHtml(code.name)}</h4><p>${escapeHtml(code.definition)}</p>${code.minimum_evidence?`<p><strong>Minimum:</strong> ${escapeHtml(code.minimum_evidence)}</p>`:''}${code.include?`<strong>Include</strong><ul>${code.include.map(v=>`<li>${escapeHtml(v)}</li>`).join('')}</ul>`:''}${code.exclude?`<strong>Exclude</strong><ul>${code.exclude.map(v=>`<li>${escapeHtml(v)}</li>`).join('')}</ul>`:''}</article>`).join('');
  }

  function rowsForExport() { return data.samples.map(row=>{const value=annotation(row);return {...value,modifiers:(value.modifiers||[]).join('|')};}); }
  function csvCell(value) { return `"${String(value??'').replaceAll('"','""')}"`; }
  function download(name,text,type) { const anchor=document.createElement('a');anchor.href=URL.createObjectURL(new Blob([text],{type}));anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(anchor.href),1000); }
  function exportCsv() { save();const rows=rowsForExport();const csv=[fields.join(','),...rows.map(row=>fields.map(field=>csvCell(row[field])).join(','))].join('\n');download(`coder_${coderId.toLowerCase().replace(/[^a-z0-9_-]+/g,'_')}.csv`,csv,'text/csv'); }
  function exportJson() { save();download(`coder_${coderId.toLowerCase().replace(/[^a-z0-9_-]+/g,'_')}.json`,JSON.stringify({coder_id:coderId,codebook_version:data.codebook.version,annotations:rowsForExport()},null,2),'application/json'); }
  function escapeHtml(value) { return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }

  ['primaryBehavior','secondaryBehavior','axProjection','outcome','confidence','needsReview','evidenceNote','notes'].forEach(id=>$(id).addEventListener('change',save));
  ['evidenceNote','notes'].forEach(id=>$(id).addEventListener('input',()=>{clearTimeout(saveTimer);saveTimer=setTimeout(save,350);}));
  $('modifiers').addEventListener('change',save);
  $('sampleSelect').onchange=()=>{const requested=$('sampleSelect').value;save();const next=data.samples.findIndex(row=>row.sample.sample_id===requested);if(next>=0){index=next;render();}};
  $('previousSample').onclick=()=>{save();if(index>0){index--;render();}};
  $('nextSample').onclick=()=>{save();if(index<data.samples.length-1){index++;render();}};
  $('incompleteOnly').onchange=renderNavigation;
  $('exportCsv').onclick=exportCsv;$('exportJson').onclick=exportJson;
  window.addEventListener?.('beforeunload',save);
  codebookReference();renderNavigation();render();
})();
