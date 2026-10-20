"""Run the ShiYan-owned knowledge backend on the cloud host."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[2]

def main():
    backend = ROOT / 'Mac/knowledge/backend'
    bridge = ROOT / 'Mac/desktop_backend/rag_service.py'
    config = os.environ.get('SHIYAN_RAG_CONFIG', '/home/ubuntu/.config/shiyan-rag/bridge.json')
    port = os.environ.get('SHIYAN_CLOUD_KNOWLEDGE_PORT', '18770')
    if not (backend / 'src/main.py').is_file():
        raise SystemExit('ShiYan knowledge source is missing')
    os.chdir(backend)
    os.execv(sys.executable, [sys.executable, str(bridge), '--config', config, '--source', str(backend), '--port', port])

if __name__ == '__main__':
    main()
