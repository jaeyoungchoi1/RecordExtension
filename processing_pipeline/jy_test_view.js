// Code-level DOM smoke test, not a browser layout/screenshot verification.
// Usage: node jy_test_view.js /path/to/task04.html (or full analysis.json)
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[2],'utf8');
const payload=process.argv[2].endsWith('.html')
 ? JSON.parse(source.match(/const DATA = (.*?);\nconst \$/s)[1]) : JSON.parse(source);
const template=fs.readFileSync(path.join(__dirname,'jy_review.html'),'utf8');
const merged=fs.readFileSync(path.join(__dirname,'jy_merged.js'),'utf8');
const treeCode=fs.readFileSync(path.join(__dirname,'jy_trees.js'),'utf8');
assert(!template.includes('Observed scanpath sequences'));
function run(data){
 const elements=new Map();
 const defaults={mode:'selected_projection',filter:'common'};
 function element(id){if(!elements.has(id))elements.set(id,{value:defaults[id]||'',textContent:'',style:{},appendChild(){},click(){},querySelectorAll:()=>[],
  set innerHTML(v){this.html=v;if(['page','basis','treeInstance','jumpSelect'].includes(id))this.value=(v.match(/option value="([^"]+)"/)||[])[1]||''},get innerHTML(){return this.html||''}});return elements.get(id)}
 const storage=new Map();
 const ctx=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>({click(){}})},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},Blob,URL,setTimeout});
 const script=template.replace('/*__JY_DATA__*/','const DATA='+JSON.stringify(data)+';').replace('/*__JY_MERGED__*/',merged).replace('/*__JY_TREES__*/',treeCode).match(/<script>([\s\S]*)<\/script>/)[1];
 vm.runInContext(script,ctx);
 assert(element('title').textContent.includes('Task'));
 assert(!element('coverage').innerHTML.includes('<td>selected</td>'));
 assert(!template.includes('AOI selection & attention statistics'));
 assert.equal(element('filter').value,'common');
 vm.runInContext(`renderRecordedTree($('domLocation'),[{id:'0',parent:null,label:'root'},{id:'1',parent:'0',label:'selected'},{id:'2',parent:'0',label:'other'},{id:'3',parent:'2',label:'hidden child'}],{'1':{label:'Selected AOI',className:'tree-hit'}})`,ctx);
 assert(element('domLocation').innerHTML.includes('tree-hit'));
 assert(!element('domLocation').innerHTML.includes('hidden child'));
 if(data.pages?.length){
  for(const page of data.pages)for(const variant of page.variants)for(const tile of variant.tiles)
   assert((data.embedded_images?.[tile.image]||tile.image).startsWith('data:image/'),'Every report image must be embedded');
  assert(element('screens').innerHTML.includes('<svg'));
  const id=Object.keys(data.pages[0].variants[0].anchors)[0];
  if(id){vm.runInContext('selectAoi('+JSON.stringify(id)+')',ctx);assert(!element('annotation').disabled);element('annotation').value='Test note';element('saveNote').onclick();assert([...storage.values()][0].includes('Test note'));assert(element('detail').textContent.includes('recorded_instances'))}
  for(const mode of ['direct','selected_projection'])for(const filter of ['all','common','selected','remaining']){element('mode').value=mode;element('filter').value=filter;element('mode').onchange();assert(element('screens').innerHTML.includes('<svg'))}
 }else assert(element('screens').innerHTML.includes('No usable'));
}
run(payload);
run({...payload,users:[],pages:[],aois:{},edges:[],status:'not_assessable'});
console.log('View smoke passed: initialization, filters, selection, annotations, empty inputs. Layout not verified.');
