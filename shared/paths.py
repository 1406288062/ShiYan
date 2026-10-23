"""Source and bundled resource locations; no platform feature policy."""
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
# Keep existing model, helper, knowledge and output locations during migration.
# Native bundles keep their established flat Resources/app layout.
APP_ROOT = REPOSITORY_ROOT / "Mac" if (REPOSITORY_ROOT / "Mac" / "desktop_server.py").is_file() else REPOSITORY_ROOT
