"""Small synthetic checks for scientific invariants; no participant batch runs."""
import csv
import tempfile
import unittest
from pathlib import Path

from jy_analysis import select_trends, tree_record, jump, transitions, summarize, load_fixations, attribute_fixations, enrich_components
from jy_page_view import build_pages
from copy import deepcopy


def user(name, counts):
    obs = []
    for aid, (n, duration) in counts.items():
        for i in range(n):
            obs.append({"aoi_id": aid, "fixation_id": f"{aid}{i}", "duration_ms": duration / n,
                        "start_ms": len(obs)*200, "end_ms": len(obs)*200+100,
                        "state_id": "s1", "index": len(obs), "dom": {}, "ax": {}})
    return {"user": name, "start_ms": 0, "observations": obs,
            "quality": {"retained_fixation_ms": sum(o["duration_ms"] for o in obs)},
            "states": [{"components": [{"aoi_id": a, "label": a, "identity": {}, "matching": "exact"} for a in counts]}]}


class AnalysisTests(unittest.TestCase):
    def test_balanced_link_identity_and_collision_fallback(self):
        class Base:
            MAX_COMPONENTS=80
            @staticmethod
            def visible_components(snapshot,ax,viewport):
                return deepcopy(snapshot['components'])
            @staticmethod
            def ax_tree(ax): return {}, {}
            @staticmethod
            def attributes(nodes,strings,i): return {'href':'/target','aria-label':strings[i]}
            @staticmethod
            def descendant_text(*args,**kwargs): return ''
        def run(names,mode='balanced'):
            snap={'strings':names,'documents':[{'nodes':{'parentIndex':[-1]*len(names),'nodeName':list(range(len(names))),'backendNodeId':list(range(len(names)))}}],
                  'components':[{'node_index':i,'backend_id':i,'tag':'a','role':'link','component_id':f'C{i}'} for i in range(len(names))]}
            return enrich_components(Base,lambda c:('','',''),snap,{'nodes':[]},{'viewport':{},'url':'https://example.org/','state_id':'s'},'1','01',[],mode)
        self.assertEqual(run(['Old title'])[0]['aoi_id'],run(['New title'])[0]['aoi_id'])
        self.assertNotEqual(run(['Old title'],'strict')[0]['aoi_id'],run(['New title'],'strict')[0]['aoi_id'])
        copies=run(['Header','Footer'])
        self.assertNotEqual(copies[0]['aoi_id'],copies[1]['aoi_id'])
        self.assertTrue(all(c['matching']=='exact_page_role_name_context_target' for c in copies))
        self.assertTrue(all(c['ambiguous'] for c in run(['Same','Same'])))
        self.assertEqual(Base.MAX_COMPONENTS,80)

    def test_scroll_mosaic_and_dynamic_fallback(self):
        def state(s,y,aid):
            return {'state_id':s,'document_id':'d','url':'https://example.org/', 'usable':True,'image':s+'.jpg',
                    'image_width':100,'image_height':100,'scroll_x':0,'scroll_y':y,'start_ms':int(s),
                    'components':[{'aoi_id':aid,'component_id':'C1','x':10,'y':60,'width':20,'height':20}]}
        u={'user':'1','states':[state('1',0,'A'),state('2',50,'B'),state('3',50,'C')],
           'observations':[{'state_id':str(i+1),'aoi_id':a} for i,a in enumerate('ABC')]}
        pages=build_pages([u],{a:{'category':'common'} for a in 'ABC'})
        mosaic=next(v for v in pages[0]['variants'] if len(v['tiles'])==2)
        self.assertEqual(mosaic['tiles'][1]['clip_top'],100)
        self.assertEqual(mosaic['anchors']['B']['cy'],120)
        self.assertEqual(mosaic['height'],150)
        self.assertTrue(any('C' in v['anchors'] for v in pages[0]['variants']))
        for v in pages[0]['variants']:
            self.assertEqual(v['alignment'][0]['shown']+v['alignment'][0]['omitted'],3)

    def test_common_and_strict_majority_both_thresholds(self):
        users = [user('1',{'A':(1,100),'B':(4,400),'C':(8,50),'D':(20,2000)}),
                 user('3',{'A':(1,100),'B':(4,400),'C':(8,50)}),user('4',{'A':(1,100)})]
        stats, t = select_trends(users)
        self.assertEqual(t['frequency'],3)
        self.assertEqual(t['duration_ms'],300)
        self.assertEqual([stats[a]['category'] for a in 'ABCD'],['common','majority','remaining','remaining'])

    def test_no_universal_baseline(self):
        stats,t=select_trends([user('1',{'A':(10,1000)}),user('3',{'A':(10,1000)}),user('4',{'B':(1,100)})])
        self.assertFalse(t['baseline_available'])
        self.assertEqual(stats['A']['category'],'remaining')

    def test_tree_lca_and_incomplete_ancestry(self):
        parents={0:None,1:0,2:1,3:1,4:0}
        a,b=tree_record(2,parents,{}),tree_record(4,parents,{})
        j=jump(a,b)
        self.assertEqual((j['up'],j['down'],j['lca_depth'],j['distance']),(2,1,0,3))
        self.assertTrue(j['from_leaf'] and j['to_leaf'])
        self.assertIsNone(tree_record(3,{3:9},{})['depth'])

    def test_projection_not_direct_and_snapshot_boundary(self):
        u=user('1',{'A':(1,100),'X':(1,100),'B':(1,100)})
        stats={a:{'category':'remaining' if a=='X' else 'common'} for a in 'AXB'}
        direct=transitions(u,stats)
        projected=transitions(u,stats,'selected_projection')
        self.assertEqual([(e['from'],e['to']) for e in direct],[('A','X'),('X','B')])
        self.assertEqual(projected[0]['skipped_fragments'],1)
        u['observations'][-1]['state_id']='s2'
        self.assertEqual(len(transitions(u,stats)),1)
        self.assertEqual(transitions(u,stats,'selected_projection')[0]['dom']['reason'],'different_snapshots')

    def test_common_nodes_do_not_imply_common_edges(self):
        users=[user('1',{'A':(1,100),'B':(1,100)}),user('3',{'B':(1,100),'A':(1,100)})]
        stats,_=select_trends(users)
        edges=[e for u in users for e in transitions(u,stats)]
        summarize(users,stats,edges)
        self.assertFalse(any(e['common_transition'] for e in edges))
        self.assertEqual(users[0]['coverage']['common']['dwell_pct'],100)

    def test_counts_deduplicate_source_fixation_fragments(self):
        u=user('1',{'A':(2,200)})
        u['observations'][1]['fixation_id']=u['observations'][0]['fixation_id']
        stats,_=select_trends([u])
        self.assertEqual(stats['A']['frequency'],1)
        self.assertEqual(stats['A']['duration_ms'],200)

    def test_fixations_use_source_ids_and_state_split_conserves_time(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'gaze.csv'
            with p.open('w',newline='') as f:
                w=csv.writer(f)
                w.writerow(['timestamp [ns]','fixation id','gaze detected in reference image',
                            'gaze position transf x [px]','gaze position transf y [px]'])
                for t in range(0,220,20):
                    w.writerow([t*1000000, '1' if t<160 else '', 'True',10,10])
            fs,q=load_fixations(p,0,220,100,75)
            self.assertEqual(len(fs),1)
            self.assertEqual(fs[0]['duration_ms'],160)
            c={'aoi_id':'A','component_id':'C1','dom':{},'ax':{}}
            states=[{'start_ms':0,'end_ms':90,'state_id':'s1','usable':True,'components':[c]},
                    {'start_ms':90,'end_ms':220,'state_id':'s2','usable':True,'components':[c]}]
            class Base:
                @staticmethod
                def component_at(cs,x,y):return cs[0]
            obs=attribute_fixations(Base,fs,states,75)
            self.assertEqual(len(obs),2)
            self.assertEqual(sum(o['duration_ms'] for o in obs),160)
            self.assertEqual(obs[0]['end_ms'],90)


if __name__=='__main__':
    unittest.main()
