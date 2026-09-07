"""Offline regression tests: python3 -m unittest discover -s .agents/skills/pr-watch."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('pr-digest').resolve()
MOCK = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]
f = json.loads(Path(os.environ['FIXTURE']).read_text())
if a[:2] == ['repo', 'view']: print('example/project')
elif a[:2] == ['pr', 'view']:
    if '--jq' in a: print('abc')
    else: print(json.dumps(dict(headRefOid='abc', state='OPEN', mergeable='MERGEABLE', headRefName='topic', reviewDecision='')))
elif a[0] == 'api':
    endpoint = next(x for x in a[1:] if x == 'graphql' or x.startswith('repos/'))
    if endpoint == 'graphql': print('viewer')
    elif endpoint.endswith('/replies'):
        with open(os.environ['CALLS'], 'a') as log: log.write('POST\\n')
        sys.exit(1)
    elif '/pulls/comments/' in endpoint: print('1')
    elif '/check-runs?' in endpoint: print(json.dumps(dict(name='tests', status='completed', conclusion='success', html_url='')))
    elif '/status?' in endpoint: pass
    elif '/issues/' in endpoint: print(json.dumps(f.get('conversation', [])))
    elif '/reviews?' in endpoint: print(json.dumps(f.get('reviews', [])))
    elif '/comments?' in endpoint: print(json.dumps(f.get('inline', [])))
    else: sys.exit(2)
else: sys.exit(2)
'''


def comment(id=12, body='Please fix this', user='reviewer', kind='User', updated='2026-01-01T00:00:00Z'):
    return dict(id=id, body=body, user=dict(login=user, type=kind),
                created_at=updated, updated_at=updated,
                html_url=f'https://github.com/example/project/pull/1#issuecomment-{id}')


class DigestTests(unittest.TestCase):
    def run_digest(self, fixture, *args):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'gh').write_text(MOCK)
            (root / 'gh').chmod(0o755)
            (root / 'fixture').write_text(json.dumps(fixture))
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ['PATH'],
                       FIXTURE=str(root / 'fixture'), CALLS=str(root / 'calls'),
                       PR_DIGEST_SEEN_DIR=str(root / 'seen'))
            result = subprocess.run(['bash', str(SCRIPT), *(args or ['1'])],
                                    cwd=tmp, env=env, text=True, capture_output=True)
            calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
            self.assertNotIn('jq: error', result.stderr)
            return result, calls

    def test_permalink_must_be_complete_and_exact(self):
        original = comment()
        for body, expected in [(original['html_url'], 0),
                               ('[fixed](' + original['html_url'] + ')', 0),
                               (original['html_url'] + '.', 0),
                               (original['html_url'] + '3.', 11),
                               (original['html_url'] + '3', 11),
                               ('#issuecomment-12', 11)]:
            with self.subTest(body=body):
                reply = comment(13, body, 'viewer', updated='2026-01-02T00:00:00Z')
                result, _ = self.run_digest(dict(conversation=[original, reply]))
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_edits_reopen_conversation(self):
        original = comment(updated='2026-01-03T00:00:00Z')
        reply = comment(13, original['html_url'], 'viewer', updated='2026-01-02T00:00:00Z')
        result, _ = self.run_digest(dict(conversation=[original, reply]))
        self.assertEqual(result.returncode, 11)

    def test_noise_requires_matching_automation(self):
        for user, kind, body, expected in [
            ('reviewer', 'User', '[vc]: Please fix this', 11),
            ('unknown[bot]', 'Bot', '[vc]: Please fix this', 11),
            ('vercel[bot]', 'Bot', '[vc]: generated deployment', 0),
            ('github-actions[bot]', 'Bot', '<!-- rakazo-playwright-screenshots -->\n### Playwright screenshots\n', 0),
            ('reviewer', 'User', '<h3>Greptile Summary</h3>', 11),
        ]:
            with self.subTest(user=user, body=body):
                result, _ = self.run_digest(dict(conversation=[comment(body=body, user=user, kind=kind)]))
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_only_effective_change_requests_block(self):
        for states, expected in [(['APPROVED'], 0), (['COMMENTED'], 0),
                                 (['CHANGES_REQUESTED'], 11),
                                 (['CHANGES_REQUESTED', 'APPROVED'], 0),
                                 (['CHANGES_REQUESTED', 'COMMENTED'], 11),
                                 (['DISMISSED'], 0)]:
            with self.subTest(states=states):
                reviews = [dict(id=i, state=state, body='Review summary',
                                submitted_at=f'2026-01-0{i+1}T00:00:00Z',
                                user=dict(login='reviewer', type='User'))
                           for i, state in enumerate(states)]
                result, _ = self.run_digest(dict(reviews=reviews))
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_inline_reply_does_not_close_conversation(self):
        inline = comment(20, 'Already fixed', 'viewer', updated='2026-01-02T00:00:00Z')
        inline['in_reply_to_id'] = 19
        result, _ = self.run_digest(dict(conversation=[comment()], inline=[inline]))
        self.assertEqual(result.returncode, 11)

    def test_inline_edits_require_a_new_reply(self):
        for updated, expected in [('2026-01-01T00:00:00Z', 0),
                                  ('2026-01-03T00:00:00Z', 11)]:
            with self.subTest(updated=updated):
                root = comment(updated=updated)
                root.update(path='example.sh', line=1, in_reply_to_id=None)
                reply = comment(13, 'Fixed', 'viewer', updated='2026-01-02T00:00:00Z')
                reply['in_reply_to_id'] = root['id']
                result, _ = self.run_digest(dict(inline=[root, reply]))
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_terminal_controls_are_removed(self):
        result, _ = self.run_digest(dict(conversation=[comment(body='Fix \x1b]0;title\x07 this')]))
        self.assertEqual(result.returncode, 11)
        self.assertNotIn('\x1b', result.stdout)
        self.assertNotIn('\x07', result.stdout)

    def test_failed_reply_is_not_retried(self):
        result, calls = self.run_digest({}, '--reply', '12', 'Fixed')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(calls, 'POST\n')


if __name__ == '__main__':
    unittest.main()
