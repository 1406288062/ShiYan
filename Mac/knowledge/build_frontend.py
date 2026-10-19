"""Build ShiYan's owned knowledge UI into the desktop web assets."""
from pathlib import Path
import os
import subprocess
ROOT = Path(__file__).resolve().parent
if __name__ == "__main__":
    env = dict(os.environ, VITE_SHIYAN_EMBEDDED="1")
    env["PATH"] = "/opt/homebrew/bin:" + env.get("PATH", "")
    subprocess.run(["npm", "run", "build", "--", "--base=/assets/knowledge-ui/",
                    "--outDir=" + str(ROOT.parent / "web/assets/knowledge-ui"), "--emptyOutDir"],
                   cwd=ROOT / "frontend", env=env, check=True)
