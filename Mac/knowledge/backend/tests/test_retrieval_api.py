import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import retrieval_app as module


class RetrievalApiTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'RETRIEVAL_API_KEY':'integration-secret','RETRIEVAL_ALLOWED_KB_IDS':'sales-kb'})
        self.env.start()
        self.client=TestClient(module.app)
        self.item={'chunk_id':'c1','document_id':'d1','document_name':'CRM手册','page_start':2,'page_end':3,'heading':'CRM价格','quote':'CRM 每席位199元。','retrieval':{'lexical_rank':1,'vector_rank':None,'vector_distance':None},'source':'knowledge_base'}
    def tearDown(self): self.env.stop(); self.client.close()
    def search(self,**kw):
        return self.client.post('/api/retrieval/search',headers={'Authorization':'Bearer integration-secret'},json={'knowledge_base_id':'sales-kb','query':'CRM 价格',**kw})
    def test_scope_before_retrieval(self):
        with patch.object(module.retrieval_service,'search') as search:
            self.assertEqual(self.search(knowledge_base_id='private-kb').status_code,403)
            self.assertEqual(self.client.post('/api/retrieval/search',json={'knowledge_base_id':'sales-kb','query':'CRM'}).status_code,401)
            search.assert_not_called()
    def test_provenance_and_lexical_degradation(self):
        with patch.object(module,'fetch_one',return_value={'id':'sales-kb'}),patch.object(module.retrieval_service,'search',return_value=[self.item]):
            response=self.search()
            self.assertEqual(response.status_code,200)
            evidence=response.json()['evidence'][0]
            self.assertEqual(evidence['page_start'],2)
            self.assertEqual(evidence['evidence_id'],'c1')
            self.assertEqual(evidence['trusted_as'],'evidence_only')
            self.assertEqual(response.json()['mode'],'lexical')
    def test_irrelevant_and_unlocated_evidence_rejected(self):
        item=dict(self.item,quote='天气很好',heading='',page_start=None)
        with patch.object(module,'fetch_one',return_value={'id':'sales-kb'}),patch.object(module.retrieval_service,'search',return_value=[item]):
            self.assertFalse(self.search().json()['reliable'])
    def test_top_k_and_extra_fields(self):
        self.assertEqual(self.search(top_k=99).status_code,422)
        self.assertEqual(self.search(user_id='another').status_code,422)
    def test_outage_is_recoverable(self):
        with patch.object(module,'fetch_one',return_value={'id':'sales-kb'}),patch.object(module.retrieval_service,'search',side_effect=RuntimeError()):
            self.assertEqual(self.search().status_code,503)

if __name__=='__main__':unittest.main()
