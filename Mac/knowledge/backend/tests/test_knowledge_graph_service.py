import sys
import unittest
from unittest.mock import patch
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from services.knowledge_graph_service import build_knowledge_graph
from services.llm_service import DeepSeekError, DeepSeekTransientError, LLMService


def document(document_id, title, root_title, topics, recommended_layout="map", relations=None):
    return {
        "id": document_id,
        "title": title,
        "filename": f"{title}.pdf",
        "tags": [],
        "_knowledge": {
            "structure": {
                "level1": {
                    "title": root_title,
                    "content": f"<p>{root_title}说明</p>",
                    "level2": topics,
                }
            },
            "recommended_layout": recommended_layout,
            "relations": relations or [],
        },
    }


def topic(title, merge_key, page, points, node_id=None):
    return {
        **({"id": node_id} if node_id else {}),
        "title": title,
        "merge_key": merge_key,
        "content": f"<p>{title}的核心解释</p>",
        "sources": [{"page_start": page, "page_end": page, "quote": f"{title}依据"}],
        "level3": points,
    }


def point(title, merge_key, page, node_id=None):
    return {
        **({"id": node_id} if node_id else {}),
        "title": title,
        "merge_key": merge_key,
        "content": f"<p>{title}的具体内容</p>",
        "sources": [{"page_start": page, "page_end": page, "quote": f"{title}原文"}],
    }


class KnowledgeGraphServiceTests(unittest.TestCase):
    def test_merges_shared_concepts_and_keeps_document_evidence(self):
        documents = [
            document("doc-a", "JVM 基础", "JVM", [topic("运行时内存", "JVM内存模型", 3, [point("堆", "JVM堆", 4)])]),
            document("doc-b", "面试补充", "Java 面试", [topic("JVM 内存模型", "JVM内存模型", 8, [point("Java 堆", "JVM堆", 9)])]),
        ]

        graph = build_knowledge_graph({"id": "kb-1", "name": "Java 面试", "description": ""}, documents)
        modules = graph["structure"]["level1"]["level2"]

        self.assertEqual(graph["structure"]["level1"]["title"], "Java 面试")
        self.assertEqual(len(modules), 1)
        self.assertEqual(modules[0]["support_count"], 2)
        self.assertEqual(len(modules[0]["level3"]), 1)
        self.assertEqual(modules[0]["level3"][0]["support_count"], 2)
        self.assertEqual(
            {source["document_id"] for source in modules[0]["level3"][0]["sources"]},
            {"doc-a", "doc-b"},
        )
    def test_same_page_keeps_distinct_evidence_quotes(self):
        documents = [
            document(
                "doc-a",
                "资料",
                "主题",
                [
                    topic(
                        "模块",
                        "模块",
                        1,
                        [point("细节", "细节", 1)],
                    )
                ],
            )
        ]

        graph = build_knowledge_graph({"id": "kb-1", "name": "资料库", "description": ""}, documents)
        module = graph["structure"]["level1"]["level2"][0]

        self.assertEqual(
            {source["quote"] for source in module["sources"]},
            {"模块依据", "细节原文"},
        )

    def test_single_document_uses_its_core_subject(self):
        documents = [document("doc-a", "报告", "供应链风险", [topic("风险来源", "风险来源", 2, [])])]
        graph = build_knowledge_graph({"id": "kb-1", "name": "研究资料", "description": ""}, documents)
        self.assertEqual(graph["title"], "供应链风险")

    def test_distinct_topics_remain_separate(self):
        documents = [
            document(
                "doc-a",
                "产品手册",
                "产品",
                [topic("安装步骤", "安装流程", 1, []), topic("性能限制", "性能限制", 6, [])],
            )
        ]
        graph = build_knowledge_graph({"id": "kb-1", "name": "产品", "description": ""}, documents)
        self.assertEqual(len(graph["structure"]["level1"]["level2"]), 2)

    def test_explicit_relation_is_fused_and_layout_is_selected(self):
        relations = [
            {
                "id": "cause-1",
                "type": "causes",
                "from": "topic_a",
                "to": "topic_b",
                "sources": [{"page_start": 3, "page_end": 3, "quote": "准备导致结果"}],
            }
        ]
        documents = [
            document(
                "doc-a",
                "流程说明",
                "处理流程",
                [
                    topic("准备", "准备", 2, [], node_id="topic_a"),
                    topic("结果", "结果", 4, [], node_id="topic_b"),
                ],
                recommended_layout="map",
                relations=relations,
            )
        ]

        graph = build_knowledge_graph({"id": "kb-1", "name": "流程", "description": ""}, documents)
        explicit = [relation for relation in graph["relations"] if not relation["derived"]]

        self.assertEqual(graph["view_mode"], "flow")
        self.assertEqual(len(explicit), 1)
        self.assertEqual(explicit[0]["type"], "causes")
        self.assertEqual(explicit[0]["label"], "因果")
        self.assertEqual(explicit[0]["support_count"], 1)

    def test_shared_topic_exposes_common_and_different_variants(self):
        documents = [
            document("doc-a", "报告 A", "主题", [topic("缓存策略", "缓存策略", 1, [])]),
            document("doc-b", "报告 B", "主题", [topic("缓存更新策略", "缓存策略", 2, [])]),
        ]

        graph = build_knowledge_graph({"id": "kb-1", "name": "研究资料", "description": ""}, documents)
        module = graph["structure"]["level1"]["level2"][0]

        self.assertEqual(module["comparison"]["status"], "different")
        self.assertTrue(module["comparison"]["common"])
        self.assertTrue(module["comparison"]["difference"])
        self.assertEqual(len(module["comparison"]["variants"]), 2)
        self.assertIn("其他资料补充", module["content"])
        self.assertEqual(len(graph["comparisons"]["common"]), 1)
        self.assertEqual(len(graph["comparisons"]["differences"]), 1)
        self.assertEqual(graph["view_mode"], "comparison")

    def test_many_documents_are_grouped_for_progressive_expansion(self):
        documents = [
            document(
                f"doc-{index}",
                f"资料 {index}",
                "共同主题",
                [topic("共同主题", "共同主题", index + 1, [])],
                recommended_layout="flow",
            )
            for index in range(6)
        ]

        graph = build_knowledge_graph({"id": "kb-1", "name": "资料库", "description": ""}, documents)

        self.assertTrue(graph["cluster_mode"])
        self.assertEqual(len(graph["clusters"]), 1)
        self.assertEqual(graph["clusters"][0]["document_count"], 6)
        self.assertEqual(graph["clusters"][0]["module_ids"], [graph["structure"]["level1"]["level2"][0]["id"]])
        self.assertEqual(graph["view_mode"], "flow")


class VerifiedSourceTests(unittest.TestCase):
    def test_source_coverage_detects_and_repairs_omitted_pages(self):
        context = (
            "[文档共 3 页、3 个分块；以下内容按原顺序覆盖全部片段]\n\n"
            "[片段 1 | 第 1-1 页]\n01 Java 基础\n问：JDK 是什么？答：开发工具。\n\n"
            "[片段 2 | 第 2-2 页]\n02 面向对象\n问：多态是什么？答：按实际对象选择重写方法。\n\n"
            "[片段 3 | 第 3-3 页]\n03 集合框架\n问：ArrayList 是什么？答：可扩容数组。"
        )
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "title": "Java 基础",
                            "sources": [{"page_start": 1, "page_end": 1}],
                            "level3": [],
                        }
                    ]
                }
            }
        }

        expected, covered = LLMService._source_coverage(result, context)
        self.assertEqual(expected, {1, 2, 3})
        self.assertEqual(covered, {1})

        LLMService._add_fallback_page_nodes(result, context, sorted(expected - covered))
        expected, covered = LLMService._source_coverage(result, context)
        self.assertEqual(covered, expected)
        self.assertEqual(
            [topic["title"] for topic in result["structure"]["level1"]["level2"]],
            ["Java 基础", "面向对象", "集合框架"],
        )

    def test_navigation_folds_coverage_topic_into_nearest_real_topic(self):
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "id": "coverage_page_1",
                            "title": "第 1 页内容补充",
                            "merge_key": "第 1 页内容补充",
                            "content": "<p>封面内容</p>",
                            "sources": [
                                {"page_start": 1, "page_end": 1, "quote": "封面内容"}
                            ],
                            "level3": [],
                        },
                        {
                            "id": "topic_2",
                            "title": "法律基础",
                            "merge_key": "法律基础",
                            "content": "<p>法律基础</p>",
                            "sources": [
                                {"page_start": 2, "page_end": 2, "quote": "法律基础"}
                            ],
                            "level3": [],
                        },
                    ]
                }
            }
        }

        LLMService._fold_coverage_topics_for_navigation(result)

        topics = result["structure"]["level1"]["level2"]
        self.assertEqual([topic["id"] for topic in topics], ["topic_2"])
        self.assertEqual(topics[0]["level3"][0]["id"], "coverage_page_1")
        self.assertEqual(result["navigation_folded_fallback_pages"], [1])

    def test_topic_group_target_treats_twelve_as_ceiling_not_goal(self):
        self.assertEqual(LLMService._topic_group_target(19), 5)
        self.assertEqual(LLMService._topic_group_target(20), 5)
        self.assertEqual(LLMService._topic_group_target(48), 12)
        self.assertEqual(LLMService._topic_group_target(80), 12)

    def test_fallback_page_nodes_are_restored_to_source_order(self):
        context = (
            "[片段 1 | 第 1-1 页]\n第一页原文。\n\n"
            "[片段 2 | 第 2-2 页]\n第二页原文。"
        )
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "id": "topic_2",
                            "title": "第二页主题",
                            "sources": [
                                {"page_start": 2, "page_end": 2, "quote": "第二页原文"}
                            ],
                            "level3": [],
                        }
                    ]
                }
            }
        }

        LLMService._add_fallback_page_nodes(result, context, [1])

        topics = result["structure"]["level1"]["level2"]
        self.assertEqual(topics[0]["id"], "coverage_page_1")
        self.assertEqual(topics[1]["id"], "topic_2")

    def test_global_topic_merge_retries_compact_plan_before_fallback(self):
        service = LLMService()
        topics = [
            {
                "id": f"topic_{index}",
                "title": f"主题 {index}",
                "merge_key": f"主题 {index}",
                "content": "<p>内容</p>",
                "sources": [],
                "level3": [],
            }
            for index in range(1, 21)
        ]
        result = {
            "structure": {
                "level1": {
                    "id": "root",
                    "title": "测试",
                    "content": "<p>测试</p>",
                    "level2": topics,
                }
            },
            "relations": [],
        }
        calls = []

        def fake_plan(_topics, _target, **_kwargs):
            calls.append(True)
            if len(calls) == 1:
                raise DeepSeekError("第一次计划超出导航数量")
            groups = []
            cursor = 1
            for index, size in enumerate([4, 4, 4, 4, 4], 1):
                ids = [f"topic_{value}" for value in range(cursor, cursor + size)]
                cursor += size
                groups.append(
                    {
                        "title": f"主题组 {index}",
                        "merge_key": f"主题组 {index}",
                        "topic_ids": ids,
                    }
                )
            return groups

        service._plan_topic_groups = fake_plan
        service._consolidate_topics_if_needed(result)

        self.assertEqual(len(calls), 2)
        level2 = result["structure"]["level1"]["level2"]
        self.assertEqual(len(level2), 5)
        self.assertTrue(all(topic.get("is_navigation_group") for topic in level2))
        self.assertEqual(result["topic_grouping"]["planner"], "model")
        self.assertEqual(result["topic_grouping"]["planner_attempts"], 2)

    def test_global_topic_merge_reduces_level2_without_losing_extracted_nodes(self):
        service = LLMService()
        topics = []
        for index in range(1, 21):
            topics.append(
                {
                    "id": f"topic_{index}",
                    "title": f"主题 {index}",
                    "merge_key": f"主题 {index}",
                    "content": f"<p>主题 {index} 内容</p>",
                    "sources": [
                        {
                            "page_start": index,
                            "page_end": index,
                            "quote": f"主题 {index} 原文",
                        }
                    ],
                    "level3": [
                        {
                            "id": f"point_{index}",
                            "title": f"知识点 {index}",
                            "merge_key": f"知识点 {index}",
                            "content": f"<p>知识点 {index} 内容</p>",
                            "sources": [
                                {
                                    "page_start": index,
                                    "page_end": index,
                                    "quote": f"知识点 {index} 原文",
                                }
                            ],
                        }
                    ],
                }
            )
        result = {
            "structure": {
                "level1": {
                    "id": "root",
                    "title": "测试",
                    "content": "<p>测试</p>",
                    "level2": topics,
                }
            },
            "relations": [
                {
                    "id": "r1",
                    "type": "sequence",
                    "from": "topic_1",
                    "to": "point_2",
                    "sources": [
                        {"page_start": 1, "page_end": 2, "quote": "关系原文"}
                    ],
                }
            ],
        }
        groups = [
            {
                "title": f"导航 {index}",
                "merge_key": f"导航 {index}",
                "topic_ids": [f"topic_{index * 2 - 1}", f"topic_{index * 2}"],
            }
            for index in range(1, 11)
        ]

        service._apply_topic_groups(result, groups)

        level2 = result["structure"]["level1"]["level2"]
        self.assertEqual(len(level2), 10)
        flattened_ids = set()

        def visit(node):
            if not isinstance(node, dict):
                return
            if node.get("id"):
                flattened_ids.add(node["id"])
            children = node.get("children")
            if not isinstance(children, list):
                children = node.get("level3") if isinstance(node.get("level3"), list) else []
            for child in children:
                visit(child)

        for topic in level2:
            visit(topic)
        for index in range(1, 21):
            self.assertIn(f"topic_{index}", flattened_ids)
            self.assertIn(f"point_{index}", flattened_ids)
        self.assertEqual(result["relations"][0]["from"], "topic_1")
        self.assertEqual(result["relations"][0]["to"], "point_2")
        self.assertEqual(
            result["topic_grouping"],
            {"before": 20, "after": 10, "mode": "dynamic_navigation"},
        )

    def test_dynamic_navigation_caps_every_page_at_twelve_children(self):
        result = {
            "structure": {
                "level1": {
                    "id": "root",
                    "title": "大文档",
                    "content": "",
                    "level2": [
                        {
                            "id": "topic_1",
                            "title": "超大主题",
                            "merge_key": "超大主题",
                            "content": "",
                            "sources": [],
                            "level3": [
                                {
                                    "id": f"point_{index}",
                                    "title": f"知识点 {index}",
                                    "merge_key": f"知识点 {index}",
                                    "content": "",
                                    "sources": [],
                                }
                                for index in range(1, 38)
                            ],
                        }
                    ],
                }
            }
        }

        LLMService._ensure_dynamic_navigation(result)
        root = result["structure"]["level1"]

        def assert_capped(node):
            children = node.get("children") if isinstance(node.get("children"), list) else []
            self.assertLessEqual(len(children), 12)
            for child in children:
                assert_capped(child)

        assert_capped(root)
        self.assertGreaterEqual(result["navigation"]["depth"], 4)

    def test_global_topic_merge_uses_compact_grouping_call(self):
        service = LLMService()
        topics = [
            {
                "id": f"topic_{index}",
                "title": f"主题 {index}",
                "merge_key": f"主题 {index}",
                "content": "<p>不应发送的长正文</p>",
                "sources": [],
                "level3": [],
            }
            for index in range(1, 21)
        ]
        result = {
            "structure": {
                "level1": {
                    "id": "root",
                    "title": "测试",
                    "content": "<p>测试</p>",
                    "level2": topics,
                }
            },
            "relations": [],
        }
        captured = []

        def fake_call(messages, **kwargs):
            captured.append((messages, kwargs))
            groups = []
            cursor = 1
            for index, size in enumerate([4, 4, 4, 4, 4], 1):
                ids = [f"topic_{value}" for value in range(cursor, cursor + size)]
                cursor += size
                groups.append(
                    {
                        "title": f"主题组 {index}",
                        "merge_key": f"主题组 {index}",
                        "topic_ids": ids,
                    }
                )
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": __import__("json").dumps({"groups": groups}, ensure_ascii=False)},
                    }
                ]
            }

        service._call_remote = fake_call
        service._consolidate_topics_if_needed(result)

        self.assertEqual(len(captured), 1)
        messages, kwargs = captured[0]
        self.assertEqual(kwargs["operation"], "knowledge_topic_merge")
        prompt_text = str(messages)
        self.assertIn("主题 1", prompt_text)
        self.assertNotIn("不应发送的长正文", prompt_text)
        level2 = result["structure"]["level1"]["level2"]
        self.assertEqual(len(level2), 5)
        self.assertTrue(all(topic.get("is_navigation_group") for topic in level2))

    def test_medium_small_document_uses_parallel_segment_generation(self):
        service = LLMService()
        context = "\n\n".join(
            f"[片段 {index} | 第 {index}-{index} 页]\n"
            + (f"第{index}页知识内容。" * 100)
            for index in range(1, 9)
        )
        expected = {"title": "并行结果"}

        with patch.object(
            service, "_generate_knowledge_batched", return_value=expected
        ) as generate_batched:
            result = service.generate_knowledge(context, "测试")

        self.assertIs(result, expected)
        call = generate_batched.call_args
        self.assertLess(call.kwargs["max_chars"], 18000)
        batches = service._split_knowledge_context(
            context, max_chars=call.kwargs["max_chars"]
        )
        self.assertGreaterEqual(len(batches), 3)
        self.assertLessEqual(len(batches), 5)

    def test_small_document_missing_pages_uses_local_fallback_without_second_model_call(self):
        service = LLMService()
        context = (
            "[片段 1 | 第 1-1 页]\n第一章原文内容。\n\n"
            "[片段 2 | 第 2-2 页]\n第二章原文内容。"
        )
        calls = []

        def fake_call(messages, **kwargs):
            calls.append(kwargs)
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": (
                                '{"title":"测试","document_type":"other","document_type_label":"测试",'
                                '"document_profile":{"language":"中文","audience":"","scope":""},'
                                '"summary":"摘要","tags":[],"recommended_layout":"map",'
                                '"structure":{"level1":{"id":"root","title":"测试","content":"<p>测试</p>",'
                                '"level2":[{"id":"topic_1","title":"第一章","merge_key":"第一章",'
                                '"content":"<p>第一章内容</p>","source_refs":[1],"evidence":"第一章原文内容",'
                                '"level3":[]}]}},"relations":[]}'
                            )
                        },
                    }
                ]
            }

        service._call_remote = fake_call
        result = service.generate_knowledge(context, "测试")

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["operation"], "knowledge_map")
        self.assertEqual(result["coverage_fallback_pages"], [2])
        expected, covered = service._source_coverage(result, context)
        self.assertEqual(covered, expected)

    def test_local_fallback_parses_numbered_interview_questions(self):
        text = (
            "while not done: Perceive Think Act Observe Evaluate。\n"
            "1.1.8 Agent Loop 听说过吗？Agent Loop 会持续观察并决定下一步。\n"
            "1.1.9 你认为当前 Agent 的核心瓶颈有哪些？可靠性、规划、成本与延迟。"
        )

        title = LLMService._fallback_page_title(text, 5)
        points = LLMService._fallback_points(text, 5, "coverage_page_5")

        self.assertEqual(title, "Agent Loop 听说过吗？")
        self.assertEqual(
            [point["title"] for point in points],
            ["Agent Loop 听说过吗？", "你认为当前 Agent 的核心瓶颈有哪些？"],
        )
        self.assertIn("持续观察", points[0]["content"])
        self.assertIn("可靠性", points[1]["content"])

    def test_segment_missing_page_uses_targeted_model_repair_before_local_fallback(self):
        service = LLMService()
        context = (
            "[片段 41 | 第 5-5 页]\nAgent Loop 原文内容。\n\n"
            "[片段 42 | 第 6-6 页]\n模型工具框架原文内容。"
        )
        calls = []

        def fake_call(messages, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                body = (
                    '{"title":"测试","document_type":"other","document_type_label":"测试",'
                    '"document_profile":{"language":"中文","audience":"","scope":""},'
                    '"summary":"摘要","tags":[],"recommended_layout":"map",'
                    '"structure":{"level1":{"id":"root","title":"测试","content":"<p>测试</p>",'
                    '"level2":[{"id":"topic_1","title":"Agent Loop","merge_key":"Agent Loop",'
                    '"content":"<p>Agent Loop</p>","source_refs":[1],"evidence":"Agent Loop 原文内容",'
                    '"level3":[]}]}}, "relations":[]}'
                )
            else:
                body = (
                    '{"title":"测试","document_type":"other","document_type_label":"测试",'
                    '"document_profile":{"language":"中文","audience":"","scope":""},'
                    '"summary":"补充","tags":[],"recommended_layout":"map",'
                    '"structure":{"level1":{"id":"root","title":"测试","content":"<p>测试</p>",'
                    '"level2":[{"id":"topic_1","title":"模型工具框架","merge_key":"模型工具框架",'
                    '"content":"<p>模型工具框架</p>","source_refs":[1],"evidence":"模型工具框架原文内容",'
                    '"level3":[]}]}}, "relations":[]}'
                )
            return {
                "choices": [
                    {"finish_reason": "stop", "message": {"content": body}}
                ]
            }

        service._call_remote = fake_call
        result = service._generate_knowledge_segment(context, "测试", "segment_1")

        self.assertEqual(len(calls), 2)
        topics = result["structure"]["level1"]["level2"]
        self.assertEqual(
            [topic["title"] for topic in topics],
            ["Agent Loop", "模型工具框架"],
        )
        self.assertNotIn("coverage_fallback_pages", result)
        expected, covered = service._source_coverage(result, context)
        self.assertEqual(covered, expected)

    def test_isolated_segment_uses_local_refs_then_maps_back_to_global_ids(self):
        service = LLMService()
        context = (
            "[片段 43 | 第 24-24 页]\n第一段关键原文。\n\n"
            "[片段 44 | 第 25-25 页]\n第二段关键原文。"
        )
        captured_prompts = []

        def fake_call(messages, **kwargs):
            captured_prompts.append(messages)
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": (
                                '{"title":"测试","document_type":"other","document_type_label":"测试",'
                                '"document_profile":{"language":"zh-CN","audience":"","scope":""},'
                                '"summary":"摘要","tags":[],"recommended_layout":"map",'
                                '"structure":{"level1":{"id":"root","title":"测试","content":"<p>测试</p>",'
                                '"level2":[{"id":"topic_1","title":"主题一","merge_key":"主题一",'
                                '"content":"<p>内容</p>","source_refs":[1],"evidence":"第一段关键原文",'
                                '"level3":[]},{"id":"topic_2","title":"主题二","merge_key":"主题二",'
                                '"content":"<p>内容</p>","source_refs":[2],"evidence":"第二段关键原文",'
                                '"level3":[]}]}},'
                                '"relations":[{"id":"r1","type":"sequence","from":"topic_1","to":"topic_2",'
                                '"source_refs":[2],"evidence":"第二段关键原文"}]}'
                            )
                        },
                    }
                ]
            }

        service._call_remote = fake_call
        result = service._generate_knowledge_segment(context, "测试", "segment_3")

        prompt_text = str(captured_prompts[0])
        self.assertIn("[片段 1 | 第 24-24 页]", prompt_text)
        self.assertIn("[片段 2 | 第 25-25 页]", prompt_text)
        self.assertNotIn("[片段 43 | 第 24-24 页]", prompt_text)

        topics = result["structure"]["level1"]["level2"]
        self.assertEqual(topics[0]["sources"][0]["page_start"], 24)
        self.assertEqual(topics[1]["sources"][0]["page_start"], 25)
        self.assertEqual(result["relations"][0]["sources"][0]["page_start"], 25)

    def test_generated_structure_preserves_all_verified_topics_and_points(self):
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "title": f"主题 {topic_index}",
                            "source_refs": [1],
                            "evidence": "正文",
                            "level3": [
                                {
                                    "title": f"知识点 {point_index}",
                                    "source_refs": [1],
                                    "evidence": "正文",
                                }
                                for point_index in range(7)
                            ],
                        }
                        for topic_index in range(12)
                    ]
                }
            }
        }

        verified_count = LLMService._attach_verified_sources(
            result, "[片段 1 | 第 1-1 页]\n正文"
        )
        topics = result["structure"]["level1"]["level2"]

        self.assertEqual(len(topics), 12)
        self.assertTrue(all(len(topic["level3"]) == 7 for topic in topics))
        self.assertEqual(verified_count, 96)

    def test_fragment_reference_controls_page_number(self):
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "title": "实验结果",
                            "source_refs": [2, 99],
                            "evidence": "准确率达到 92%",
                            "level3": [],
                        }
                    ]
                }
            }
        }
        context = (
            "[文档共 9 页、2 个分块，完整送入以下内容]\n\n"
            "[片段 1 | 第 1-1 页]\n研究背景\n\n"
            "[片段 2 | 第 7-8 页]\n实验显示，准确率达到 92%，满足目标。"
        )

        LLMService._attach_verified_sources(result, context)
        source = result["structure"]["level1"]["level2"][0]["sources"][0]
        self.assertEqual((source["page_start"], source["page_end"]), (7, 8))
        self.assertEqual(source["quote"], "准确率达到 92%")

    def test_relations_require_known_nodes_and_verifiable_evidence(self):
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "id": "topic_1",
                            "title": "先行",
                            "source_refs": [1],
                            "evidence": "先行证据",
                            "level3": [],
                        },
                        {
                            "id": "topic_2",
                            "title": "后续",
                            "source_refs": [1],
                            "evidence": "后续证据",
                            "level3": [],
                        },
                    ]
                }
            },
            "relations": [
                {
                    "id": "valid",
                    "type": "causes",
                    "from": "topic_1",
                    "to": "topic_2",
                    "source_refs": [1],
                    "evidence": "先行证据导致后续证据",
                },
                {
                    "id": "unknown-endpoint",
                    "type": "sequence",
                    "from": "topic_1",
                    "to": "missing",
                    "source_refs": [1],
                    "evidence": "先行证据",
                },
                {
                    "id": "unknown-evidence",
                    "type": "conflicts",
                    "from": "topic_1",
                    "to": "topic_2",
                    "source_refs": [1],
                    "evidence": "模型猜测",
                },
            ],
        }

        LLMService._attach_verified_sources(
            result,
            "[片段 1 | 第 2-4 页]\n先行证据；后续证据。先行证据导致后续证据。",
        )

        self.assertEqual([relation["id"] for relation in result["relations"]], ["valid"])
        self.assertEqual(result["relations"][0]["type"], "causes")
        self.assertEqual(result["relations"][0]["sources"][0]["page_end"], 4)

    def test_node_with_unverified_quote_is_removed(self):
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {"title": "结论", "source_refs": [1], "evidence": "原文没有这句话", "level3": []}
                    ]
                }
            }
        }
        context = "[片段 1 | 第 3-3 页]\n这是可以核对的原文。"
        verified_count = LLMService._attach_verified_sources(result, context)
        self.assertEqual(result["structure"]["level1"]["level2"], [])
        self.assertEqual(verified_count, 0)

    def test_evidence_allows_formatting_differences_but_keeps_source_quote(self):
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "title": "JVM",
                            "source_refs": [1],
                            "evidence": "Java虚拟机负责执行字节码,并管理内存",
                            "level3": [],
                        }
                    ]
                }
            }
        }
        verified_count = LLMService._attach_verified_sources(
            result,
            "[片段 1 | 第 2-2 页]\nJava 虚拟机负责执行字节码，并管理内存。",
        )
        source = result["structure"]["level1"]["level2"][0]["sources"][0]

        self.assertEqual(verified_count, 1)
        self.assertEqual(source["quote"], "Java 虚拟机负责执行字节码，并管理内存")

    def test_evidence_unicode_normalization_keeps_original_offsets(self):
        result = {
            "structure": {
                "level1": {
                    "level2": [
                        {
                            "title": "通信频率",
                            "source_refs": [1],
                            "evidence": "范围",
                            "level3": [],
                        }
                    ]
                }
            }
        }

        verified_count = LLMService._attach_verified_sources(
            result,
            "[片段 1 | 第 1-1 页]\nx㎒范围与通信",
        )
        source = result["structure"]["level1"]["level2"][0]["sources"][0]

        self.assertEqual(verified_count, 1)
        self.assertEqual(source["quote"], "范围")


class AnswerCitationTests(unittest.TestCase):
    def test_invalid_source_numbers_are_removed(self):
        service = LLMService()
        service._call_remote = lambda *args, **kwargs: {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": "结论[来源99]，补充[来源1]。"},
                }
            ]
        }

        result = service.answer_question(
            "问题",
            "唯一依据",
            "资料库",
            citations=[
                {"document_name": "资料", "page_start": 1, "page_end": 1, "quote": "唯一依据"}
            ],
        )

        self.assertEqual(result["answer"], "结论，补充[来源1]。")


class VisualPageRequestTests(unittest.TestCase):
    def test_visual_page_uses_chat_completions_image_content(self):
        service = LLMService()
        captured = {}

        def fake_call(messages, **kwargs):
            captured["messages"] = messages
            captured["kwargs"] = kwargs
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": '{"text":"表格列名：数值 42","is_blank":false}'
                        },
                    }
                ]
            }

        service._call_remote = fake_call
        result = service.extract_visual_page(
            "data:image/jpeg;base64,ZmFrZQ==",
            6,
            "",
            ["image_heavy"],
        )

        user_content = captured["messages"][1]["content"]
        self.assertEqual(user_content[0]["type"], "text")
        self.assertEqual(user_content[1]["type"], "image_url")
        self.assertEqual(user_content[1]["image_url"]["detail"], "high")
        self.assertEqual(captured["kwargs"]["operation"], "pdf_page_vision")
        self.assertEqual(captured["kwargs"]["temperature"], 0.0)
        self.assertIn("数值 42", result["text"])

    def test_ephemeral_visual_page_retries_transient_gateway_failure(self):
        service = LLMService()
        attempts = {"count": 0}

        def flaky(*_args, **_kwargs):
            attempts["count"] += 1
            if attempts["count"] < 3:
                raise DeepSeekTransientError("Connection reset by peer")
            return {"text": "第 83 页恢复成功", "is_blank": False, "content_kinds": ["text"]}

        service.extract_visual_page = flaky
        with patch("services.llm_service.time.sleep") as sleep:
            result = service.extract_visual_page_ephemeral(
                "data:image/jpeg;base64,ZmFrZQ==",
                83,
                "",
                ["table"],
            )

        self.assertEqual(result["text"], "第 83 页恢复成功")
        self.assertEqual(attempts["count"], 3)
        self.assertEqual(sleep.call_count, 2)

    def test_truncated_response_uses_actual_operation_label(self):
        truncated_response = {
            "choices": [
                {
                    "finish_reason": "length",
                    "message": {"content": "partial"},
                }
            ]
        }

        service = LLMService()

        def fake_call(*_, **__):
            return truncated_response

        service._call_remote = fake_call

        with self.assertRaisesRegex(DeepSeekError, "PDF 页面转写被截断"):
            service.extract_visual_page(
                "data:image/jpeg;base64,ZmFrZQ==",
                3,
                "",
                ["low_text"],
            )

        with self.assertRaisesRegex(DeepSeekError, "AI 问答被截断"):
            service.answer_question("问题", "依据", "资料")

    def test_string_false_is_not_treated_as_a_blank_page(self):
        service = LLMService()

        def fake_call(*_, **__):
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": '{"text":"","is_blank":"false"}'},
                    }
                ]
            }

        service._call_remote = fake_call
        with self.assertRaisesRegex(DeepSeekError, "未返回第 2 页"):
            service.extract_visual_page(
                "data:image/jpeg;base64,ZmFrZQ==",
                2,
                "",
                ["low_text"],
            )


if __name__ == "__main__":
    unittest.main()
