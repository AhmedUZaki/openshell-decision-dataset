from pathlib import Path
import sys
import re
import hashlib

root = Path('/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/dist/control-ui')
index = root / 'index.html'
asset_hash = hashlib.sha256((root / 'assets/openshell-events-panel.js').read_bytes()).hexdigest()[:12]
marker = f'<script defer src="./assets/openshell-events-panel.js?v={asset_hash}"></script>'
text = index.read_text()
if '--remove' in sys.argv:
    index.write_text(re.sub(r'<script defer src="\./assets/openshell-events-panel\.js\?v=[a-f0-9]+"></script>\n?', '', text))
    print('OpenShell panel injection removed.')
elif marker not in text:
    text = re.sub(r'<script defer src="\./assets/openshell-events-panel\.js\?v=[a-f0-9]+"></script>\n?', '', text)
    if '</body>' not in text:
        raise RuntimeError('Unexpected dashboard HTML')
    index.write_text(text.replace('</body>', marker + '\n</body>'))
    print('OpenShell events panel enabled.')
else:
    print('OpenShell events panel already enabled.')
