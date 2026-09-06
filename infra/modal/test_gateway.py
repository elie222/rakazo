import hashlib
import hmac
import time
import unittest
from unittest.mock import MagicMock, patch
import screen_gateway as gateway
import screens

class GatewayTest(unittest.TestCase):
    def request(self, key, token, control=False):
        handler=object.__new__(gateway.Handler)
        handler.path=f'/websockify?screen={key}&cadre_token={token}&view_only={str(not control).lower()}'
        handler.headers={'Upgrade':'websocket'}
        handler.connection=MagicMock();handler.send_error=MagicMock()
        return handler

    def test_view_capability_cannot_open_a_different_agent_screen(self):
        key=screens.screen_key('agent-b')
        token=hmac.new(b'secret',screens.screen_key('agent-a').encode(),hashlib.sha256).hexdigest()
        handler=self.request(key,token)
        with patch.dict(gateway.os.environ,{'CADRE_SCREEN_VIEW_TOKEN':'secret'}), patch.object(screens,'load',return_value={'index':2}), patch.object(gateway.socket,'create_connection') as connect:
            handler.do_GET()
        handler.send_error.assert_called_once_with(403);connect.assert_not_called()

    def test_valid_view_is_routed_to_its_own_display(self):
        key=screens.screen_key('agent-b')
        token=hmac.new(b'secret',key.encode(),hashlib.sha256).hexdigest()
        handler=self.request(key,token)
        with patch.dict(gateway.os.environ,{'CADRE_SCREEN_VIEW_TOKEN':'secret'}), patch.object(screens,'load',return_value={'index':2}), patch.object(gateway.socket,'create_connection',side_effect=OSError) as connect:
            handler.do_GET()
        handler.send_error.assert_not_called();connect.assert_called_once_with(('127.0.0.1',6084),timeout=10)

    def test_expired_and_wrong_control_grants_cannot_open_stream(self):
        for state in [{'index':1,'token':'right','expiresAt':time.time()-1},{'index':1,'token':'wrong','expiresAt':time.time()+100}]:
            handler=self.request(screens.screen_key('agent'),'right',True)
            with patch.object(screens,'load',return_value=state), patch.object(gateway.socket,'create_connection') as connect:
                handler.do_GET()
            handler.send_error.assert_called_once_with(403);connect.assert_not_called()

    def test_revocation_closes_an_already_open_control_stream(self):
        active={'index':1,'token':'right','expiresAt':time.time()+100}
        handler=self.request(screens.screen_key('agent'),'right',True)
        with patch.object(screens,'load',side_effect=[active,active,{}]), patch.object(gateway.socket,'create_connection') as connect, patch.object(gateway.select,'select',return_value=([],[],[])) as select:
            handler.do_GET()
        connect.assert_called_once_with(('127.0.0.1',6083),timeout=10);select.assert_called_once()

if __name__=='__main__':unittest.main()
