import ast
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'resources' / 'python'))
from tool_protocol import supports_tools, template_message, parse_message, ParsedStream


class Tokenizer:
    chat_template = '{{ tools }} {{ messages }}'
    response_template = {'tool_calls': {}}

    def parse_response(self, text, *, prefix, tools):
        self.last = (prefix, tools)
        return json.loads(text)


class ToolProtocolTests(unittest.TestCase):
    def test_capability_is_fail_closed(self):
        self.assertFalse(supports_tools(object()))
        self.assertTrue(supports_tools(Tokenizer()))
        self.assertFalse(supports_tools(Tokenizer(), vision=True))
        class Ordinary(Tokenizer):
            response_template = {'content': {}}
        self.assertFalse(supports_tools(Ordinary()))

    def test_template_keeps_tool_identity_and_typed_arguments(self):
        message = {'role': 'assistant', 'content': '', 'reasoning_content': 'thinking', 'tool_calls': [{'id': 'a', 'type': 'function', 'function': {'name': 'calculator', 'arguments': '{"a":2}'}}]}
        result = template_message(message)
        self.assertEqual(result['tool_calls'][0]['function']['arguments'], {'a': 2})
        self.assertEqual(result['reasoning_content'], 'thinking')
        self.assertEqual(message['tool_calls'][0]['function']['arguments'], '{"a":2}')
        self.assertEqual(template_message({'role': 'tool', 'content': 'data', 'tool_call_id': 'a'})['tool_call_id'], 'a')

    def test_normalizes_structured_calls_without_prose_detection(self):
        tok = Tokenizer()
        msg = parse_message(tok, json.dumps({'content': 'calculator(2)', 'tool_calls': [{'function': {'name': 'calculator', 'arguments': {'a': 2}}}]}), 'prompt', [])
        self.assertEqual(msg['tool_calls'][0]['type'], 'function')
        self.assertEqual(json.loads(msg['tool_calls'][0]['function']['arguments']), {'a': 2})
        self.assertEqual(tok.last[0], 'prompt')
        self.assertNotIn('tool_calls', parse_message(tok, '{"content":"calculator(2)"}', '', []))

    def test_incremental_parser_holds_incomplete_protocol_and_emits_calls_once(self):
        events = []
        stream = ParsedStream(Tokenizer(), 'prefix', [], events.append)
        stream.feed('{"content":"hello",')
        self.assertEqual(events, [])
        stream.feed('"tool_calls":[{"function":{"name":"calculator","arguments":{"a":2}}}]}')
        stream.finish()
        self.assertEqual(events[0], {'content': 'hello'})
        self.assertEqual(len([e for e in events if 'tool_calls' in e]), 1)

    def test_rejects_malformed_structures_and_unstable_streams(self):
        with self.assertRaises(ValueError):
            parse_message(Tokenizer(), '{"role":"system","content":"unsafe"}', '', [])
        with self.assertRaises(ValueError):
            parse_message(Tokenizer(), '{"tool_calls":[{"function":{"name":"x","arguments":"not json"}}]}', '', [])
        stream = ParsedStream(Tokenizer(), '', [], lambda e: None)
        stream.publish({'content': 'first'})
        with self.assertRaises(ValueError):
            stream.publish({'content': 'revised'})

    def test_server_normalization_keeps_tool_roles_and_normal_chat(self):
        # Load pure normalization functions without importing torch or starting the HTTP server.
        tree = ast.parse((ROOT / 'resources' / 'python' / 'server.py').read_text(encoding='utf8'))
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'normalize_messages']
        namespace = {}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), '<normalize_messages>', 'exec'), namespace)
        normalize = namespace['normalize_messages']
        self.assertEqual(normalize([{'role': 'user', 'content': 'hello'}])[0], {'role': 'user', 'content': 'hello', 'images': []})
        calls = [{'id': 'a', 'type': 'function', 'function': {'name': 'calculator', 'arguments': '{}'}}]
        result = normalize([{'role': 'assistant', 'content': None, 'tool_calls': calls}, {'role': 'tool', 'content': 'result', 'tool_call_id': 'a'}])
        self.assertEqual(result[0]['tool_calls'], calls)
        self.assertEqual(result[1]['role'], 'tool')
        self.assertEqual(result[1]['tool_call_id'], 'a')


if __name__ == '__main__':
    unittest.main()
