import tempfile
import unittest
from pathlib import Path
from memory_bridge import MemoryBridge

class BridgeTests(unittest.TestCase):
    def test_running_sessions_receive_revision_and_deletion(self):
        with tempfile.TemporaryDirectory() as root:
            store = Path(root) / 'MEMORY.md'
            store.write_text('test-project: v1')
            bridge = MemoryBridge(root)
            def request(i, session):
                return {'id': i, 'method': 'session/prompt', 'params': {'sessionId': session, 'prompt': [{'type': 'text', 'text': 'read'}]}}
            for i, s in [(1, 'a'), (2, 'b')]:
                self.assertIn('v1', bridge.request(request(i, s))['params']['prompt'][-1]['text'])
                bridge.response({'id': i, 'result': {'stopReason': 'end_turn'}})
            self.assertEqual(len(bridge.request(request(3, 'b'))['params']['prompt']), 1)
            store.write_text('test-project: v2')
            self.assertIn('v2', bridge.request(request(4, 'b'))['params']['prompt'][-1]['text'])
            bridge.response({'id': 4, 'result': {'stopReason': 'cancelled'}})
            self.assertEqual(len(bridge.request(request(5, 'b'))['params']['prompt']), 2)
            bridge.response({'id': 5, 'result': {'stopReason': 'end_turn'}})
            store.unlink()
            self.assertIn('"MEMORY.md": ""', bridge.request(request(6, 'b'))['params']['prompt'][-1]['text'])

    def test_commands_untouched_and_unreadable_memory_blocks(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = MemoryBridge(root)
            command = {'id': 1, 'method': 'session/prompt', 'params': {'sessionId': 'a', 'prompt': [{'type': 'text', 'text': '/status'}]}}
            self.assertEqual(bridge.request(command), command)
            (Path(root) / 'MEMORY.md').write_bytes(b'x' * 65537)
            command['params']['prompt'][0]['text'] = 'do work'
            with self.assertRaises(ValueError): bridge.request(command)

if __name__ == '__main__': unittest.main()
