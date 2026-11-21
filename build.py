#!/usr/bin/env python3
"""Publish only frontend assets. Application data remains in PostgreSQL."""
from pathlib import Path
import argparse
import shutil
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=Path('/workspace/Website/public/sportx-plan'))
args = parser.parse_args()
root = Path(__file__).resolve().parent
args.output.mkdir(parents=True, exist_ok=True)
for name in ('index.html', 'style.css', 'app.js', 'conversations.js', 'favicon.svg'):
    shutil.copyfile(root / 'src' / name, args.output / name)
    (args.output / name).chmod(0o644)
# Remove obsolete generated public files; the live document is served by the API.
for name in ('data.json', 'documento.html', 'plan.md'):
    (args.output / name).unlink(missing_ok=True)
print(f'Published frontend assets to {args.output}; database unchanged.')
