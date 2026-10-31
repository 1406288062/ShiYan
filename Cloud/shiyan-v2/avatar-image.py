"""Decode account avatars and emit a metadata-free, bounded JPEG on stdout."""
import io
import sys
import warnings

from PIL import Image, ImageOps

MAX_BYTES = 1024 * 1024
Image.MAX_IMAGE_PIXELS = 4096 * 4096
warnings.simplefilter("error", Image.DecompressionBombWarning)


def main():
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Avatar is too large")
    with Image.open(io.BytesIO(raw)) as source:
        if source.format != "JPEG" or source.width * source.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError("Invalid avatar format or dimensions")
        source.load()
        image = ImageOps.exif_transpose(source).convert("RGB")
        size = min(512, image.width, image.height)
        image = ImageOps.fit(image, (size, size), method=Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, "JPEG", quality=88, optimize=True)
        data = output.getvalue()
        if len(data) > MAX_BYTES:
            raise ValueError("Avatar is too large")
        sys.stdout.buffer.write(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Neither image data nor parser diagnostics belong in account-service logs.
        sys.exit(1)
