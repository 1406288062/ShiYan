"""Reduce image upload bytes while leaving the local attachment untouched."""
from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError


MINIMUM_BYTES = 64 * 1024
LARGE_COPY_BYTES = 512 * 1024


def upload_image_copy(data: bytes, suffix: str, *, mask: bool = False) -> tuple[bytes, str]:
    """Choose a smaller encoding; keep text resolution, alpha and mask pixels.

    Storage.request_image already limits oversized input dimensions. This step
    changes only the upload encoding, never the original file or its metadata.
    The same bytes produce a stable copy so chunked retries reuse their hash.
    """
    if mask or len(data) < MINIMUM_BYTES:
        return data, suffix
    candidates: list[bytes] = []
    try:
        with Image.open(BytesIO(data)) as opened:
            if getattr(opened, "is_animated", False):
                return data, suffix
            image = ImageOps.exif_transpose(opened)
            image.load()
            mode = "RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB"
            image = image.convert(mode)
            profile = opened.info.get("icc_profile")
            options = {"icc_profile": profile} if profile else {}
            # Lossless WebP often wins for screenshots; a high quality lossy
            # copy usually wins for photographs. Preserve resolution in both.
            for settings in ({"lossless": True}, {"quality": 90}):
                output = BytesIO()
                try:
                    image.save(output, "WEBP", method=4, exact=True, **options, **settings)
                    candidates.append(output.getvalue())
                except (OSError, ValueError, KeyError):
                    continue
            if candidates and min(map(len, candidates)) > LARGE_COPY_BYTES:
                output = BytesIO()
                try:
                    image.save(output, "WEBP", quality=86, method=4, exact=True, **options)
                    candidates.append(output.getvalue())
                except (OSError, ValueError, KeyError):
                    pass
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return data, suffix
    if not candidates:
        return data, suffix
    smallest = min(candidates, key=len)
    # Avoid a lossy rewrite for a negligible saving, and never expand a file.
    if len(smallest) > len(data) * 0.90:
        return data, suffix
    return smallest, ".webp"
