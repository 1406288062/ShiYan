from pathlib import Path
import importlib.util
import unittest
from unittest.mock import patch, Mock

path=Path(__file__).resolve().parents[3]/'Mac/knowledge/backend/src/services/qwen_http.py'
spec=importlib.util.spec_from_file_location('qwen_http',path);worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
ENDPOINT='http://127.0.0.1:8770/v1/embeddings'
def response(vector):
    return Mock(json=lambda:{'data':[{'embedding':vector}]},raise_for_status=lambda:None)
class QwenWorkerTests(unittest.TestCase):
    def test_query_instruction_and_normalization_match_existing_model(self):
        progress=[]
        with patch.object(worker.requests,'post',return_value=response([2.0]+[0.0]*1023)) as post:
            vectors=worker.embed_qwen(['问题'],'question_embedding','检索资料',ENDPOINT,lambda a,b:progress.append((a,b)))
            self.assertEqual(post.call_args.kwargs['json']['input'],'Instruct: 检索资料\nQuery:问题')
            self.assertEqual(vectors[0],[1.0]+[0.0]*1023)
            self.assertEqual(progress,[(0,1),(1,1)])
    def test_document_text_does_not_get_query_instruction(self):
        with patch.object(worker.requests,'post',return_value=response([1.0]+[0.0]*1023)) as post:
            worker.embed_qwen(['原文'],'document_embedding','instruction',ENDPOINT)
            self.assertEqual(post.call_args.kwargs['json']['input'],'原文')
    def test_rejects_wrong_dimensions_nan_and_zero_vectors(self):
        for v in [[1.0],[float('nan')]+[0.0]*1023,[0.0]*1024]:
            with patch.object(worker.requests,'post',return_value=response(v)):
                with self.assertRaises(ValueError):worker.embed_qwen(['text'],'document_embedding','',ENDPOINT)
    def test_no_external_host_or_embedded_credentials(self):
        for url in ['https://example.org/v1/embeddings','http://127.0.0.1:8770/other','http://user:secret@127.0.0.1:8770/v1/embeddings']:
            with self.assertRaises(ValueError):worker.embed_qwen(['text'],'document_embedding','',url)

if __name__=='__main__':unittest.main()
