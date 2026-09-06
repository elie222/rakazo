import json
from pathlib import Path
import tempfile
import unittest
from browser_sessions import SharedState, cookie_map, Broker, Browser
from unittest.mock import Mock, patch
from browser_sessions import managed_profiles


class SharedSessionsTest(unittest.TestCase):
    def converge(self, state, peer, values):
        state.observe(peer, values)
        changes = state.changes(peer)
        state.applied(peer, changes)
        return state.previous[peer]

    def test_sign_in_sync_and_unchanged_peer_does_not_overwrite_rotation(self):
        state = SharedState()
        self.converge(state, 'a', {})
        self.converge(state, 'b', {})
        state.observe('a', {'session': 'signed-in'})
        self.assertEqual(self.converge(state, 'b', {}), {'session': 'signed-in'})
        state.observe('a', {'session': 'rotated'})
        state.observe('b', {'session': 'signed-in'})
        self.assertEqual(state.changes('b'), {'session': 'rotated'})

    def test_sign_out_and_stale_reconnecting_screen_cannot_resurrect_cookie(self):
        state = SharedState({'session': 'old'})
        self.converge(state, 'a', {'session': 'old'})
        self.converge(state, 'b', {'session': 'old'})
        state.observe('a', {})
        self.assertEqual(self.converge(state, 'b', {'session': 'old'}), {})
        state.disconnect('b')
        self.assertEqual(self.converge(state, 'b', {'session': 'old'}), {})

    def test_new_screen_does_not_delete_other_sessions(self):
        state = SharedState({'session': 'shared'})
        self.assertEqual(self.converge(state, 'new', {}), {'session': 'shared'})

    def test_independent_updates_merge_and_deletion_wins_over_unchanged_peer(self):
        state = SharedState()
        self.converge(state, 'a', {'first': 'a'})
        self.converge(state, 'b', {'first': 'a'})
        state.observe('a', {})
        state.observe('b', {'first': 'a', 'second': 'b'})
        self.assertEqual(state.values, {'first': None, 'second': 'b'})

    def test_separate_workspaces_never_share_state(self):
        one, two = SharedState(), SharedState()
        self.converge(one, 'bot', {'secret': 'workspace-one'})
        self.assertEqual(self.converge(two, 'bot', {}), {})

    def test_partitioned_http_only_cookie_attributes_survive(self):
        cookie = {'name': 'session', 'value': 'test', 'domain': '.example.test',
                  'path': '/', 'secure': True, 'httpOnly': True, 'sameSite': 'None',
                  'session': True, 'expires': -1, 'size': 12,
                  'partitionKey': {'topLevelSite': 'https://example.test', 'hasCrossSiteAncestor': True}}
        mapped = cookie_map([cookie])
        value = next(iter(mapped.values()))
        self.assertTrue(value['httpOnly'])
        self.assertEqual(value['partitionKey'], cookie['partitionKey'])
        self.assertNotIn('size', value)
        self.assertNotIn('expires', value)
        self.assertEqual(cookie_map([{**cookie, 'partitionKeyOpaque': True}]), {})

    def test_persistence_includes_logout_tombstones_and_partitioned_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'shared-sessions.json'
            broker = Broker(file)
            broker.cookies.values = {'test-cookie': None}
            broker.storage['https://example.test/'] = SharedState({'token': 'test-only'})
            broker.save()
            restored = Broker(file)
            self.assertEqual(restored.cookies.values, {'test-cookie': None})
            self.assertEqual(restored.storage['https://example.test/'].values, {'token': 'test-only'})
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('previous', json.loads(file.read_text()))

    def test_custom_browser_profiles_are_not_opted_into_sharing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('chromium', 'bot-' + 'a' * 64, 'private-browser', 'bot-malformed'):
                (root / name).mkdir()
                (root / name / 'DevToolsActivePort').touch()
            with patch('browser_sessions.PROFILES', root):
                self.assertEqual({p.name for p in managed_profiles()}, {'chromium', 'bot-' + 'a' * 64})

    def test_cookie_deletion_uses_page_target_and_keeps_partition(self):
        browser = Browser.__new__(Browser)
        browser.cdp = Mock()
        browser.cdp.call.side_effect = [
            {'targetInfos': [{'type': 'page', 'targetId': 'page'}]},
            {'sessionId': 'session'}, {}, {},
        ]
        partition = {'topLevelSite': 'https://example.test', 'hasCrossSiteAncestor': True}
        key = json.dumps(['session', '.example.test', '/', partition])
        browser.apply_cookies({key: None})
        browser.cdp.call.assert_any_call('Network.deleteCookies', {
            'name': 'session', 'domain': '.example.test', 'path': '/', 'partitionKey': partition,
        }, 'session')
        browser.cdp.call.assert_any_call('Target.detachFromTarget', {'sessionId': 'session'})

    def test_partitioned_storage_does_not_mix_origins_or_top_level_sites(self):
        states = {'site-a': SharedState(), 'site-b': SharedState()}
        self.converge(states['site-a'], 'bot', {'token': 'a'})
        self.assertEqual(self.converge(states['site-b'], 'bot', {}), {})


if __name__ == '__main__':
    unittest.main()
