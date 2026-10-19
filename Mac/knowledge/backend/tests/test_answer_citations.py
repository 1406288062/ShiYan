"""Regression coverage for grounded citations, history projection and transport."""
import asyncio
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
_runtime = tempfile.TemporaryDirectory(prefix='rag-grounding-tests-')
with patch.dict(os.environ, {'DATA_DIR': _runtime.name,
        'DATABASE_PATH': str(Path(_runtime.name) / 'knowledge.db'),
        'STORAGE_DIR': str(Path(_runtime.name) / 'storage'),
        'CHROMA_DIR': str(Path(_runtime.name) / 'chroma')}):
    sys.path.insert(0, str(ROOT / 'src'))
    import main as api
    from services import agent_service as agent_module
    from services.agent_service import select_answer_citations
    from services.llm_service import LLMService


class CitationTests(unittest.TestCase):
    def setUp(self):
        self.items = [
            {'document_id': 'd1', 'document_name': '预算', 'page_start': 1,
             'page_end': 1, 'quote': '预算427元。', 'source': 'knowledge_base'},
            {'document_id': 'd2', 'document_name': '无关资料', 'page_start': 9,
             'page_end': 9, 'quote': '天气晴。', 'source': 'knowledge_base'},
            {'document_id': 'd1', 'document_name': '预算', 'page_start': 1,
             'page_end': 1, 'quote': '有效期13天。', 'source': 'knowledge_base'},
        ]

    def test_only_actually_used_sources_and_first_appearance_numbering(self):
        result = select_answer_citations({'answer': '天气晴。[来源2] 预算427元。[来源1]'}, self.items)
        self.assertEqual([c['document_id'] for c in result['citations']], ['d2', 'd1'])
        self.assertEqual(result['answer'], '天气晴。[来源1] 预算427元。[来源2]')

    def test_same_page_duplicate_sources_merge_quotes_without_losing_provenance(self):
        original = copy.deepcopy(self.items)
        result = select_answer_citations({'answer': '预算427元、有效期13天。[来源1][来源3]'}, self.items)
        self.assertEqual(len(result['citations']), 1)
        self.assertEqual(result['citations'][0]['page_start'], 1)
        self.assertIn('13天', result['citations'][0]['quote'])
        self.assertEqual(result['answer'].count('[来源1]'), 1)
        self.assertEqual(self.items, original)

    def test_no_citation_is_invented_for_an_uncited_answer(self):
        result = select_answer_citations({'answer': '你好，请说明具体问题。'}, self.items)
        self.assertEqual(result['citations'], [])
        self.assertNotIn('引用：', result['answer'])

    def test_invalid_source_numbers_are_not_exposed(self):
        result = select_answer_citations({'answer': '内容[来源0][来源99]'}, self.items)
        self.assertEqual(result['citations'], [])
        self.assertEqual(result['answer'], '内容')

    def test_insufficient_or_ambiguous_answers_never_expose_retrieval_hits(self):
        for status in ['no_context', 'needs_clarification', 'insufficient_evidence']:
            with self.subTest(status=status):
                result = select_answer_citations({'answer': '资料中没有足够依据。[来源1][来源2]', 'status': status}, self.items)
                self.assertEqual(result['citations'], [])
                self.assertNotIn('[来源', result['answer'])

    def test_recognizable_old_automatic_reference_tail_is_projected_away(self):
        text = '问题“一个”没有完整说明要询问什么。\n\n引用：\n[来源1] 预算 第 1-1 页\n[来源2] 无关资料 第 9-9 页'
        result = select_answer_citations({'answer': text}, self.items)
        self.assertEqual(result['answer'], '问题“一个”没有完整说明要询问什么。')
        self.assertEqual(result['citations'], [])

    def test_arbitrary_prose_after_reference_header_is_preserved(self):
        text = '解释如下。\n\n引用：\n这句话是正文，不能直接删除。'
        self.assertEqual(select_answer_citations({'answer': text}, self.items)['answer'], text)

    def test_partial_answer_keeps_supported_fact_but_not_missing_information_citation(self):
        result = select_answer_citations({'answer': '预算427元。[来源1]\n电话号码资料中没有足够依据。[来源2]'}, self.items)
        self.assertEqual(len(result['citations']), 1)
        self.assertIn('427元。[来源1]', result['answer'])
        self.assertNotIn('[来源2]', result['answer'])

    def test_grounded_description_of_insufficient_information_is_not_treated_as_a_refusal(self):
        result = select_answer_citations({'answer': '资料不足时系统会提示补充问题。[来源1]'}, self.items)
        self.assertEqual(len(result['citations']), 1)
        self.assertIn('[来源1]', result['answer'])

    def test_english_markers_and_web_sources_keep_original_url(self):
        web = {'source': 'web', 'url': 'https://example.test/a', 'quote': '内容', 'document_name': '网页'}
        result = select_answer_citations({'answer': '事实[source 1]'}, [web])
        self.assertEqual(result['answer'], '事实[来源1]')
        self.assertEqual(result['citations'][0]['url'], web['url'])

    def test_history_read_does_not_rewrite_stored_rows_or_user_messages(self):
        row = {'role': 'assistant', 'content': '问题“一个”没有完整说明。\n\n引用：\n[来源1] 预算 第 1-1 页',
               'citations_json': json.dumps(self.items), 'status': 'success'}
        original = copy.deepcopy(row)
        result = api._serialize_chat_message(row)
        self.assertEqual(result['citations'], [])
        self.assertEqual(row, original)
        row['role'] = 'user'
        self.assertEqual(api._serialize_chat_message(row)['content'], row['content'])

    def test_agent_returns_selected_sources_not_the_entire_ranked_result(self):
        service = agent_module.AgentService()
        with patch.object(agent_module, 'fetch_one', side_effect=[{'knowledge_base_id': 'kb'}, {'name': '资料'}]), \
             patch.object(service, '_transition'), \
             patch.object(agent_module.retrieval_service, 'search', return_value=self.items), \
             patch.object(agent_module.llm_service, 'answer_question', return_value={'answer': '预算427元。[来源1]', 'status': 'success'}):
            output = service.run_query('run', '预算是多少')
        self.assertEqual(len(output['citations']), 1)
        self.assertEqual(output['citations'][0]['document_id'], 'd1')

    def test_short_valid_term_is_not_rejected_by_length(self):
        service = LLMService()
        payload = {'answer': 'RAG 是检索增强生成。[来源1]', 'answer_status': 'answered'}
        remote = {'choices': [{'message': {'content': json.dumps(payload)}, 'finish_reason': 'stop'}]}
        with patch.object(service, '_call_remote', return_value=remote):
            result = service.answer_question('RAG', '真实检索上下文', '资料', citations=self.items)
        self.assertEqual(result['status'], 'success')
        self.assertIn('[来源1]', result['answer'])

    def test_structured_clarification_is_citation_free(self):
        service = LLMService()
        payload = {'answer': '请补充完整问题。[来源1]', 'answer_status': 'needs_clarification'}
        remote = {'choices': [{'message': {'content': json.dumps(payload)}, 'finish_reason': 'stop'}]}
        with patch.object(service, '_call_remote', return_value=remote):
            result = service.answer_question('一个', '检索上下文', '资料', citations=self.items)
        self.assertEqual(result['status'], 'needs_clarification')
        self.assertNotIn('[来源', result['answer'])

    def test_legacy_plain_model_response_remains_supported(self):
        service = LLMService()
        remote = {'choices': [{'message': {'content': '预算427元。[来源1]'}, 'finish_reason': 'stop'}]}
        with patch.object(service, '_call_remote', return_value=remote):
            self.assertEqual(service.answer_question('预算', '上下文', '资料', citations=self.items)['answer'], '预算427元。[来源1]')

    def test_graph_build_is_offloaded_without_changing_response_shape(self):
        graph = {'structure': {'level1': {'level2': []}}, 'module_count': 0}
        with patch.object(api, '_kb_for_user', return_value={'id': 'kb'}) as access, \
             patch.object(api, 'fetch_all', return_value=[]), \
             patch.object(api, 'run_in_threadpool', new_callable=AsyncMock, return_value=graph) as work:
            result = asyncio.run(api.get_knowledge_graph('kb', {'id': 'owner'}))
        access.assert_called_once_with('kb', 'owner')
        work.assert_awaited_once_with(api.build_knowledge_graph, {'id': 'kb'}, [])
        self.assertEqual(result, graph)


class CompanionCompressionTests(unittest.TestCase):
    def test_large_json_is_compressed_only_when_the_caller_accepts_gzip(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        path = Path('/Users/yu/codex/拾燕/Mac/desktop_backend/rag_service.py')
        spec = importlib.util.spec_from_file_location('compression_companion', path)
        companion = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(companion)
        original = FastAPI()
        payload = {'text': '知识主题' * 40000}

        @original.get('/health')
        def health():
            return payload

        with tempfile.TemporaryDirectory(prefix='rag-gzip-tests-') as directory:
            directory = Path(directory)
            (directory / 'src').mkdir()
            (directory / 'src/main.py').write_text('')
            config = directory / 'bridge.json'
            config.write_text(json.dumps({'secret': 'test-secret-' * 4}))
            config.chmod(0o600)
            modules = {'src.main': SimpleNamespace(app=original), 'database': SimpleNamespace(), 'auth_service': SimpleNamespace()}
            with patch.object(sys, 'path', list(sys.path)), patch.object(companion.importlib, 'import_module', side_effect=modules.__getitem__):
                app = companion.create_app(config, directory)
            with TestClient(app) as client:
                auth = {'Authorization': 'Bearer ' + 'test-secret-' * 4}
                plain = client.get('/health', headers={**auth, 'Accept-Encoding': 'identity'})
                zipped = client.get('/health', headers={**auth, 'Accept-Encoding': 'gzip'})
                self.assertNotIn('content-encoding', plain.headers)
                self.assertEqual(zipped.headers['content-encoding'], 'gzip')
                self.assertLess(int(zipped.headers['content-length']), int(plain.headers['content-length']) // 10)
                self.assertEqual(zipped.json(), payload)
                self.assertEqual(plain.json(), payload)
                self.assertEqual(client.get('/health').status_code, 401)


if __name__ == '__main__':
    unittest.main()
