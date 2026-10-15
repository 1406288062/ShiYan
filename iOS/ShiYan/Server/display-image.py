 
 
 
 
import sys
from pathlib import Path
from PIL import Image
source, destination = map(Path, sys.argv[1:3])
with Image.open(source) as image:
    image.load()
    if image.mode in ('RGBA', 'LA') and image.getchannel('A').getextrema()[0] < 255:
        raise SystemExit(2)
    if image.mode == 'P' and 'transparency' in image.info:
        raise SystemExit(2)
    image.convert('RGB').save(destination, 'JPEG', quality=94, subsampling=0, optimize=True)
print(destination.stat().st_size)
