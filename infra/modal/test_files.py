import base64
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock
import computer_rpc as rpc

class FileBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name).resolve()
        self.old=rpc.ROOT;rpc.ROOT=self.base/'home';rpc.ROOT.mkdir()
    def tearDown(self):rpc.ROOT=self.old;self.tmp.cleanup()
    def test_bulk_file_round_trip_and_symlink_escape_rejection(self):
        with patch.object(os,'fchown'):
            rpc.run({'op':'writeBatch','files':[{'path':'notes/a.txt','content':base64.b64encode(b'hello').decode()}]})
        self.assertEqual(rpc.run({'op':'readBatch','paths':['notes/a.txt']}),[{'content':base64.b64encode(b'hello').decode()}])
        outside=self.base/'private';outside.mkdir();(outside/'secret').write_text('private')
        (rpc.ROOT/'escape').symlink_to(outside,target_is_directory=True)
        for op in ['read','write','list']:
            with self.assertRaises((OSError,ValueError)):
                rpc.run({'op':op,'path':'escape/secret' if op!='list' else 'escape','content':'eA=='})
        self.assertEqual((outside/'secret').read_text(),'private')
    def test_directory_substitution_cannot_redirect_an_open_read(self):
        parent=rpc.ROOT/'notes';parent.mkdir();(parent/'a.txt').write_text('allowed')
        outside=self.base/'private';outside.mkdir();(outside/'a.txt').write_text('private')
        original=os.open
        def swap(name,*args,**kwargs):
            fd=original(name,*args,**kwargs)
            if name=='notes':
                parent.rename(rpc.ROOT/'moved');parent.symlink_to(outside,target_is_directory=True)
            return fd
        with patch.object(os,'open',side_effect=swap):
            result=rpc.run({'op':'read','path':'notes/a.txt'})
        self.assertEqual(base64.b64decode(result['content']),b'allowed')
    def test_command_keeps_operation_marker_and_scoped_environment(self):
        operation='test-command'
        process=MagicMock(pid=123)
        def wait(**_):
            self.assertEqual((self.base/operation).read_text(),'123')
            return 0
        process.wait.side_effect=wait
        with patch.object(rpc,'marker',side_effect=lambda value:self.base/value), patch.object(rpc.screens,'resolve',return_value=('screen-hash',{'index':2})), patch.object(rpc.subprocess,'Popen',return_value=process) as popen:
            rpc.execute({'operationId':operation,'screenKey':'agent','argv':['true'],'env':{'TASK_TOKEN':'scoped','DISPLAY':':9'}})
        env=popen.call_args.kwargs['env']
        self.assertEqual(env['TASK_TOKEN'],'scoped');self.assertEqual(env['DISPLAY'],':3')
        self.assertFalse((self.base/operation).exists())

    def test_screen_capacity_does_not_block_non_graphical_commands(self):
        process=MagicMock(pid=123);process.wait.return_value=0
        with patch.object(rpc,'marker',side_effect=lambda value:self.base/value), patch.object(rpc.screens,'resolve',side_effect=rpc.screens.ScreenUnavailableError('full')), patch.object(rpc.subprocess,'Popen',return_value=process) as popen:
            self.assertEqual(rpc.execute({'operationId':'command','screenKey':'ninth','argv':['true']})['code'],0)
        self.assertEqual(popen.call_args.kwargs['env']['DISPLAY'],'')

    def test_directory_substitution_cannot_redirect_a_write(self):
        parent=rpc.ROOT/'notes';parent.mkdir()
        outside=self.base/'private';outside.mkdir();(outside/'a.txt').write_text('private')
        original=os.open
        def swap(name,*args,**kwargs):
            fd=original(name,*args,**kwargs)
            if name=='notes':
                parent.rename(rpc.ROOT/'moved');parent.symlink_to(outside,target_is_directory=True)
            return fd
        with patch.object(os,'open',side_effect=swap), patch.object(os,'fchown'):
            rpc.run({'op':'write','path':'notes/a.txt','content':base64.b64encode(b'allowed').decode()})
        self.assertEqual((outside/'a.txt').read_text(),'private')
        self.assertEqual((rpc.ROOT/'moved/a.txt').read_text(),'allowed')

    def test_traversal_and_batch_limits(self):
        with self.assertRaises(ValueError):rpc.run({'op':'read','path':'../private'})
        with self.assertRaises(ValueError):rpc.run({'op':'readBatch','paths':['a']*9})
        with self.assertRaises(ValueError):rpc.run({'op':'writeBatch','files':[{}]*9})

if __name__=='__main__':unittest.main()
