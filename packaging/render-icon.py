# Rebuild the Windows icon after editing icon.svg. Requires Chrome and Pillow.
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

here = Path(__file__).resolve().parent
chrome = Path(os.environ.get(
    "DIFFWRITE_CHROME", str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe")
))
with tempfile.TemporaryDirectory(prefix="diffwrite-icon-") as directory:
    temp = Path(directory)
    screenshot = temp / "icon.png"
    subprocess.run([
        str(chrome), "--headless", "--disable-gpu", "--no-first-run",
        f"--user-data-dir={temp / 'chrome'}", "--force-device-scale-factor=1",
        "--hide-scrollbars", "--default-background-color=00000000",
        "--window-size=320,320", f"--screenshot={screenshot}", (here / "icon.svg").as_uri(),
    ], check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    with Image.open(screenshot) as source:
        image = source.convert("RGBA").crop((0, 0, 256, 256))
        if image.getpixel((0, 0))[3] != 0 or image.getpixel((128, 128))[3] != 255:
            raise RuntimeError("SVG was not rendered at the expected size or transparency")
        image.save(here / "icon.ico", sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
