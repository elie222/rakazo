"""Build the fork's computer image on Modal; no local Docker daemon required."""
from pathlib import Path
import modal

HERE = Path(__file__).resolve().parent
COMPUTER = HERE.parent / 'sandboxes' / 'computer'
app = modal.App('cadre-computers')
image = (modal.Image.from_dockerfile(COMPUTER / 'Dockerfile', context_dir=COMPUTER, add_python="3.12")
    .apt_install('python3-websocket')
    .add_local_file(HERE / 'browser_sessions.py', '/opt/cadre/browser_sessions.py', copy=True)
    .add_local_file(HERE / 'computer_rpc.py', '/opt/cadre/computer_rpc.py', copy=True)
    .add_local_file(HERE / 'screens.py', '/opt/cadre/screens.py', copy=True)
    .add_local_file(HERE / 'screen_gateway.py', '/opt/cadre/screen_gateway.py', copy=True)
    .add_local_file(HERE / 'start.sh', '/opt/cadre/start.sh', copy=True))

if __name__ == '__main__':
    with modal.enable_output(), app.run():
        built = image.build(app)
        print('MODAL_IMAGE_ID=' + built.object_id)
