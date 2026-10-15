import hashlib
import unittest
from io import BytesIO
from unittest.mock import patch

from PIL import Image, ImageDraw

from desktop_backend.upload_image import upload_image_copy


def png(image):
    out = BytesIO()
    image.save(out, "PNG", compress_level=0)
    return out.getvalue()


class UploadImageTests(unittest.TestCase):
    def test_text_screenshot_gets_smaller_without_resampling_or_mutating_original(self):
        image = Image.new("RGB", (1600, 1000), "white")
        draw = ImageDraw.Draw(image)
        for row in range(10, 990, 24):
            draw.text((12, row), "Settings / Memory 0123456789 ABC xyz", fill="#15233a")
        original = png(image)
        original_hash = hashlib.sha256(original).digest()
        copy, suffix = upload_image_copy(original, ".png")
        self.assertEqual(suffix, ".webp")
        self.assertLess(len(copy), len(original) // 2)
        with Image.open(BytesIO(copy)) as decoded:
            self.assertEqual(decoded.size, image.size)
            self.assertEqual(decoded.convert("RGB").tobytes(), image.tobytes())
        self.assertEqual(hashlib.sha256(original).digest(), original_hash)
        self.assertEqual(upload_image_copy(original, ".png"), (copy, suffix))

    def test_transparency_and_mask_pixels_are_preserved(self):
        image = Image.new("RGBA", (640, 400), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 620, 380), fill=(40, 90, 200, 96))
        original = png(image)
        copy, suffix = upload_image_copy(original, ".png")
        with Image.open(BytesIO(copy)) as decoded:
            self.assertEqual(decoded.convert("RGBA").tobytes(), image.tobytes())
        self.assertEqual(upload_image_copy(original, ".png", mask=True), (original, ".png"))

    def test_tiny_invalid_and_already_small_images_are_not_expanded(self):
        self.assertEqual(upload_image_copy(b"invalid" * 20000, ".png"), (b"invalid" * 20000, ".png"))
        image = Image.new("RGB", (100, 100), "white")
        tiny = BytesIO()
        image.save(tiny, "WEBP", lossless=True)
        original = tiny.getvalue()
        self.assertEqual(upload_image_copy(original, ".webp"), (original, ".webp"))

    def test_photographic_colour_image_uses_smaller_copy_at_original_dimensions(self):
        image = Image.effect_noise((1200, 900), 28).convert("RGB")
        original = png(image)
        copy, suffix = upload_image_copy(original, ".png")
        self.assertEqual(suffix, ".webp")
        self.assertLess(len(copy), len(original) * 0.75)
        with Image.open(BytesIO(copy)) as decoded:
            self.assertEqual(decoded.size, image.size)

    def test_exif_orientation_is_applied_once_to_upload_copy(self):
        image = Image.effect_noise((1200, 800), 30).convert("RGB")
        exif = Image.Exif()
        exif[274] = 6
        out = BytesIO()
        image.save(out, "JPEG", quality=96, exif=exif)
        original = out.getvalue()
        copy, suffix = upload_image_copy(original, ".jpg")
        self.assertEqual(suffix, ".webp")
        with Image.open(BytesIO(copy)) as decoded:
            self.assertEqual(decoded.size, (800, 1200))
            self.assertNotIn(274, decoded.getexif())

    def test_unavailable_webp_encoder_falls_back_to_original(self):
        original = png(Image.new("RGB", (500, 400), "white"))
        with patch.object(Image.Image, "save", side_effect=OSError("encoder unavailable")):
            self.assertEqual(upload_image_copy(original, ".png"), (original, ".png"))

    def test_animation_is_not_flattened_to_one_frame(self):
        frames = [Image.effect_noise((400, 400), 40).convert("RGB") for _ in range(2)]
        out = BytesIO()
        frames[0].save(out, "WEBP", lossless=True, save_all=True, append_images=frames[1:], duration=100)
        original = out.getvalue()
        self.assertGreater(len(original), 65536)
        self.assertEqual(upload_image_copy(original, ".webp"), (original, ".webp"))


if __name__ == "__main__":
    unittest.main()
