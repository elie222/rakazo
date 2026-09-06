import concurrent.futures
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import screens

class ScreensTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.old=screens.STATE;screens.STATE=Path(self.tmp.name)
        self.mock=patch.object(screens,'ensure',side_effect=lambda s,k:s);self.mock.start()
    def tearDown(self):
        self.mock.stop();screens.STATE=self.old;self.tmp.cleanup()
    def test_parallel_agents_get_distinct_screens(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            rows=list(pool.map(lambda i:screens.resolve(f'bot-{i}',f'run-{i}:1'),range(8)))
        self.assertEqual({s['index'] for _,s in rows},set(range(1,9)))
        with self.assertRaises(RuntimeError):screens.resolve('ninth','run:1')
    def test_stale_release_and_takeover_do_not_touch_new_grant(self):
        key,_=screens.resolve('bot','run:2')
        with self.assertRaises(RuntimeError):screens.resolve('bot','old:1')
        screens.release('bot','old:1');self.assertEqual(screens.load(key)['lease'],'run:2')
        screens.control('bot','user-old','old-token',True)
        screens.control('bot','user-new','new-token',True)
        screens.control('bot','user-old',None,False)
        self.assertEqual(screens.load(key)['token'],'new-token')
        screens.control('bot','user-new',None,False)
        self.assertNotIn('token',screens.load(key))
    def test_release_one_agent_keeps_peer_and_browser_screen(self):
        ka,a=screens.resolve('a','a:1');kb,b=screens.resolve('b','b:1')
        screens.release('a','a:1')
        self.assertNotIn('lease',screens.load(ka));self.assertEqual(screens.load(kb)['lease'],'b:1')
        self.assertEqual(screens.resolve('a','a:2')[1]['index'],a['index'])
    def test_user_control_is_not_reclaimed(self):
        for i in range(8):screens.resolve(str(i),f'{i}:1')
        screens.release('0','0:1');screens.control('0','human','token',True)
        with self.assertRaises(RuntimeError):screens.resolve('new','new:1')
        screens.control('0','human',None,False)
        with patch.object(screens,'retire') as retire:
            _,state=screens.resolve('new','new:1')
            self.assertEqual(state['index'],1);retire.assert_called_once()

if __name__=='__main__':unittest.main()
