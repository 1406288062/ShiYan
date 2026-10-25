#!/usr/bin/env python3
 
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import sysconfig
import time

from packaging.requirements import Requirement

for _parent in Path(__file__).resolve().parents:
    if (_parent / "shared" / "paths.py").is_file():
        sys.path.insert(0, str(_parent))
        break
from shared.paths import APP_ROOT, REPOSITORY_ROOT

PROJECT = APP_ROOT
APP = PROJECT / "dist" / "拾燕.app"
NATIVE = REPOSITORY_ROOT / "apps" / "desktop" / "native"
BUILD = NATIVE / "build"
ROOT_PACKAGES = [
    "torch", "numpy", "Pillow", "opencv-python",
    "fastapi", "uvicorn", "httpx", "python-multipart",
]
EXTERNAL_LIBRARIES = [
    "/opt/homebrew/opt/mpdecimal/lib/libmpdec.4.dylib",
    "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib",
    "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib",
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/opt/homebrew/opt/xz/lib/liblzma.5.dylib",
    "/opt/homebrew/opt/zstd/lib/libzstd.1.dylib",
]
MACHO_MAGIC = {
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
}


def run(args: list[str | Path], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run([str(arg) for arg in args], check=True, text=True,
                          capture_output=True, **kwargs)


def say(message: str) -> None:
    print(message, flush=True)


def normalize(name: str) -> str:
    return name.lower().replace("_", "-")


def dependency_closure() -> list[metadata.Distribution]:
    queue = list(ROOT_PACKAGES)
    found = {}
    while queue:
        name = queue.pop(0)
        key = normalize(name)
        if key in found:
            continue
        dist = metadata.distribution(name)
        found[key] = dist
        for raw in dist.requires or []:
            requirement = Requirement(raw)
            if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                continue
            queue.append(requirement.name)
    return [found[key] for key in sorted(found)]


def copy_runtime(framework: Path, target: Path) -> dict:
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)

    def ignore(directory: str, names: list[str]):
        ignored = []
        if Path(directory) == framework / "lib" / "python3.14":
            ignored.extend(name for name in names if name == "site-packages")
        return ignored

    shutil.copytree(framework, target, symlinks=True, ignore=ignore)
    site = target / "lib" / "python3.14" / "site-packages"
    site.mkdir(parents=True)
    distributions = dependency_closure()
    total = 0
    copied = set()
    manifest = []
    for dist in distributions:
        count = 0
        size = 0
        source_site = Path(dist.locate_file("")).resolve()
        for entry in dist.files or []:
            source = Path(dist.locate_file(entry))
            try:
                relative = source.resolve().relative_to(source_site)
            except ValueError:
                continue
            if not source.is_file():
                continue
            destination = site / relative
            if relative not in copied:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination, follow_symlinks=True)
                copied.add(relative)
                total += source.stat().st_size
            count += 1
            size += source.stat().st_size
        manifest.append({"name": dist.metadata["Name"], "version": dist.version,
                         "fileCount": count, "bytes": size})
    say(f"Copied Python runtime and {len(distributions)} package distributions ({total / 1024**2:.1f} MiB).")
    return {"packages": manifest, "packageBytes": total}


def macho_files(root: Path) -> list[Path]:
    files = []
    for path in root.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            with path.open("rb") as handle:
                if handle.read(4) in MACHO_MAGIC:
                    files.append(path)
        except OSError:
            continue
    return files


def linked_libraries(path: Path) -> list[str]:
    output = run(["/usr/bin/otool", "-L", path]).stdout
    return [line.strip().split(" (", 1)[0] for line in output.splitlines()[1:]
            if line.startswith("\t")]


def relocate_libraries(source_framework: Path, target_framework: Path, bundle_frameworks: Path) -> dict:
    mapping = {}
    runtime_python = target_framework / "Python"
    mapping[str(source_framework / "Python")] = runtime_python
    mapping[str(Path(sys.base_prefix) / "Python")] = runtime_python
    mapping["/opt/homebrew/opt/python@3.14/Frameworks/Python.framework/Versions/3.14/Python"] = runtime_python
    dylib_dir = bundle_frameworks / "Libraries"
    dylib_dir.mkdir(parents=True, exist_ok=True)
    queue = list(EXTERNAL_LIBRARIES)
    unique = {}
    while queue:
        source = Path(queue.pop(0))
        resolved = source.resolve()
        if not source.is_file():
            raise RuntimeError(f"Required local dynamic library does not exist: {source}")
        if resolved not in unique:
            destination = dylib_dir / source.name
            shutil.copy2(source, destination)
            unique[resolved] = destination
            for dependency in linked_libraries(source):
                if dependency.startswith("/opt/homebrew/") and dependency != str(source):
                    queue.append(dependency)
        mapping[str(source)] = unique[resolved]
        mapping[str(resolved)] = unique[resolved]

    binaries = macho_files(bundle_frameworks)
    patched = 0
    for path in binaries:
        replacements = []
        for dependency in linked_libraries(path):
            if dependency.startswith("/opt/homebrew/"):
                destination = mapping.get(dependency)
                if destination is None:
                    resolved = str(Path(dependency).resolve())
                    destination = mapping.get(resolved)
                if destination is None:
                    raise RuntimeError(f"Unbundled dependency: {path}: {dependency}")
                relative = os.path.relpath(destination, path.parent)
                replacements += ["-change", dependency, "@loader_path/" + relative]
        if replacements:
            run(["/usr/bin/install_name_tool", *replacements, path])
            patched += 1
        if path == runtime_python or path.parent == dylib_dir:
            run(["/usr/bin/install_name_tool", "-id",
                 "@loader_path/" + path.name, path])
        commands = run(["/usr/bin/otool", "-l", path]).stdout.splitlines()
        for index, line in enumerate(commands):
            if line.strip() == "cmd LC_RPATH":
                entry = next((item.strip() for item in commands[index + 1:index + 6]
                              if item.strip().startswith("path ")), "")
                original = entry.split(" (offset", 1)[0][5:]
                if original.startswith("/opt/homebrew/"):
                    run(["/usr/bin/install_name_tool", "-delete_rpath", original, path])

    unresolved = []
    for path in binaries:
        for dependency in linked_libraries(path):
            if dependency.startswith(("/opt/homebrew/", "/Users/")):
                unresolved.append({"binary": str(path.relative_to(APP)), "dependency": dependency})
    if unresolved:
        raise RuntimeError("Absolute external runtime references remain: " + json.dumps(unresolved))
    say(f"Relocated {patched} binaries; bundled {len(unique)} external libraries; absolute dependency audit passed.")
    return {"machoFiles": len(binaries), "relocatedBinaries": patched,
            "externalLibraries": sorted(p.name for p in unique.values()),
            "absoluteDependencyAudit": "passed"}


def compile_native() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-O",
         "-target", "arm64-apple-macosx14.0",
         "-framework", "AppKit", "-framework", "WebKit", "-framework", "Foundation",
         "-framework", "AVFoundation", "-framework", "Speech", "-framework", "Quartz", "-framework", "ImageIO",
         "-parse-as-library", NATIVE / "SpeechTranscriptAccumulator.swift",
         NATIVE / "SpeechSession.swift", NATIVE / "Speech.swift", NATIVE / "QwenVoicePlayback.swift", NATIVE / "BrowserWorkspace.swift", NATIVE / "WorkspaceChrome.swift", NATIVE / "VoiceCallPanel.swift", NATIVE / "App.swift",
         "-o", BUILD / "ShiYan"])
    helper = BUILD / "ShiYanIdentity"
    source = NATIVE / "Identity.swift"
    if not helper.exists() or helper.stat().st_mtime < source.stat().st_mtime:
        run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-O",
             "-target", "arm64-apple-macosx14.0",
             "-framework", "Foundation", "-framework", "Security", "-framework", "CryptoKit",
             source, "-o", helper])
        run(["/usr/bin/codesign", "--force", "--sign", "-", helper])
    macos = APP / "Contents" / "MacOS"
    macos.mkdir(parents=True, exist_ok=True)
    shutil.copy2(BUILD / "ShiYan", macos / "ShiYan")
    shutil.copy2(helper, macos / "ShiYanIdentity")
    (macos / "ShiYan").chmod(0o755)
    (macos / "ShiYanIdentity").chmod(0o755)
    say("Compiled AppKit/WKWebView app and copied the Keychain identity helper.")


def copy_application(require_complete: bool) -> None:
    resources = APP / "Contents" / "Resources"
    target = resources / "app"
    target.mkdir(parents=True, exist_ok=True)
    sources = {
        "desktop_server.py": PROJECT / "desktop_server.py",
        "desktop_backend": REPOSITORY_ROOT / "shared" / "backend",
        "web": REPOSITORY_ROOT / "shared" / "frontend",
        "src": REPOSITORY_ROOT / "shared" / "image",
        "models": PROJECT / "models",
        "shared/paths.py": REPOSITORY_ROOT / "shared" / "paths.py",
        "shared/launcher.py": REPOSITORY_ROOT / "shared" / "launcher.py",
        "shared/compute": REPOSITORY_ROOT / "shared" / "compute",
        "apps/desktop/adapters": REPOSITORY_ROOT / "apps" / "desktop" / "adapters",
        "config/platforms.json": REPOSITORY_ROOT / "config" / "platforms.json",
    }
    if require_complete:
        missing = [name for name, source in sources.items() if not source.exists()]
        if missing:
            raise RuntimeError("Application sources not ready: " + ", ".join(missing))
    for name, source in sources.items():
        if not source.exists():
            continue
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            if name == "models" and destination.exists():
                for model in source.glob("*.pth"):
                    dest = destination / model.name
                    if not dest.exists() or model.stat().st_size != dest.stat().st_size:
                        shutil.copy2(model, dest)
            else:
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(source, destination,
                    ignore=shutil.ignore_patterns("__pycache__", ".DS_Store", "*.pyc", "*.log", ".env", ".env.*"))
        else:
            shutil.copy2(source, destination)
    configuration = target / "platforms.json"
    if configuration.exists() or configuration.is_symlink():
        configuration.unlink()
    if (target / "config" / "platforms.json").is_file():
        configuration.symlink_to("config/platforms.json")
    for name in ["main.py", "webui.py", "legacy_webui.py", "requirements.txt", "requirements-desktop.txt", "logo.png"]:
        if (PROJECT / name).is_file():
            shutil.copy2(PROJECT / name, target / name)
    iconset = BUILD / "ShiYan.iconset"
    iconset.mkdir(exist_ok=True)
    icon_source = REPOSITORY_ROOT / "shared" / "frontend" / "assets" / "app-icon.png"
    if not icon_source.exists():
        raise RuntimeError("Missing the verified ShiYan app icon: web/assets/app-icon.png")
    if icon_source.exists():
        for pixels in [16, 32, 64, 128, 256, 512, 1024]:
            if pixels <= 512 and pixels != 64:
                run(["/usr/bin/sips", "-z", str(pixels), str(pixels), icon_source,
                     "--out", iconset / f"icon_{pixels}x{pixels}.png"])
            if pixels >= 32 and pixels != 128:
                base = pixels // 2
                run(["/usr/bin/sips", "-z", str(pixels), str(pixels), icon_source,
                     "--out", iconset / f"icon_{base}x{base}@2x.png"])
        run(["/usr/bin/iconutil", "-c", "icns", iconset, "-o", resources / "ShiYan.icns"])
    info = {
        "CFBundleName": "拾燕",
        "CFBundleDisplayName": "拾燕",
        "CFBundleDevelopmentRegion": "zh_CN",
        "CFBundleLocalizations": ["zh_CN", "en"],
        "CFBundleIdentifier": "com.shiyan.image-enhancer.desktop",
        "CFBundleExecutable": "ShiYan",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "2.2.0",
        "CFBundleVersion": "20261011.8",
        "CFBundleIconFile": "ShiYan.icns",
        "LSMinimumSystemVersion": "14.0",
        "NSHighResolutionCapable": True,
        "NSSupportsAutomaticGraphicsSwitching": True,
        "NSPrincipalClass": "NSApplication",
        "NSMicrophoneUsageDescription": "用于将您说的话实时转成输入框草稿。",
        "NSSpeechRecognitionUsageDescription": "用于中文语音输入，在系统支持时优先在此 Mac 上识别。",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True, "NSAllowsArbitraryLoadsInWebContent": True,
                                  "NSExceptionDomains": {"127.0.0.1": {
                                      "NSExceptionAllowsInsecureHTTPLoads": True,
                                      "NSIncludesSubdomains": False}}},
    }
    with (APP / "Contents" / "Info.plist").open("wb") as handle:
        plistlib.dump(info, handle)
    say("Copied current application sources, bundled models, app icon and Info.plist.")


def sign_app(sign_runtime: bool) -> None:
    if sign_runtime:
        files = macho_files(APP / "Contents" / "Frameworks")
        for path in sorted(files, key=lambda p: len(p.parts), reverse=True):
            run(["/usr/bin/codesign", "--force", "--sign", "-", path])
        nested_apps = list((APP / "Contents" / "Frameworks").rglob("*.app"))
        for nested in sorted(nested_apps, key=lambda p: len(p.parts), reverse=True):
            run(["/usr/bin/codesign", "--force", "--sign", "-", nested])
        framework = APP / "Contents" / "Frameworks" / "Python.framework"
        run(["/usr/bin/codesign", "--force", "--sign", "-", framework])
    run(["/usr/bin/codesign", "--force", "--sign", "-", APP / "Contents" / "MacOS" / "ShiYan"])
    run(["/usr/bin/codesign", "--force", "--sign", "-", APP])
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", APP])
    say("Ad-hoc signature and deep bundle verification passed.")


def runtime_smoke() -> dict:
    framework = APP / "Contents" / "Frameworks" / "Python.framework" / "Versions" / "3.14"
    python = framework / "bin" / "python3.14"
    site = framework / "lib" / "python3.14" / "site-packages"
    code = (
        "import json,sys,ssl,sqlite3,torch,numpy,cv2,PIL,fastapi,uvicorn,httpx;"
        "assert '/Contents/Frameworks/' in sys.prefix;"
        "assert '/Contents/Frameworks/' in torch.__file__;"
        "x=torch.ones((1,3,4,4));"
        "y=torch.nn.Conv2d(3,3,3,padding=1)(x);"
        "print(json.dumps({'python':sys.version.split()[0],'prefix':sys.prefix,"
        "'torch':torch.__version__,'torchPath':torch.__file__,"
        "'mpsAvailable':torch.backends.mps.is_available(),"
        "'cpuTensorShape':list(y.shape),'ssl':ssl.OPENSSL_VERSION,"
        "'sqlite':sqlite3.sqlite_version,'imports':'passed'}))"
    )
    environment = {
        "HOME": str(Path.home()), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "PYTHONHOME": str(framework), "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "SSL_CERT_FILE": str(site / "certifi" / "cacert.pem"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
    }
    result = run([python, "-B", "-I", "-c", code], env=environment, cwd=APP, timeout=90)
    report = json.loads(result.stdout.strip().splitlines()[-1])
    say("Isolated bundled Python imports and real CPU tensor operation passed.")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true",
                        help="Reuse the already-copied runtime and update app/native sources.")
    parser.add_argument("--runtime-only", action="store_true",
                        help="Prepare native/runtime while application source work is in progress.")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This build runs only on the authorized ARM64 Mac.")
    if sys.version_info[:2] != (3, 14):
        raise SystemExit("Use /opt/homebrew/bin/python3.14 for this local build.")
    BUILD.mkdir(parents=True, exist_ok=True)
    APP.mkdir(parents=True, exist_ok=True)
    framework_source = Path(sys.base_prefix).resolve()
    frameworks = APP / "Contents" / "Frameworks"
    framework_target = frameworks / "Python.framework" / "Versions" / "3.14"
    manifest_path = BUILD / "build-manifest.json"
    manifest = json.loads(manifest_path.read_text()) if args.refresh and manifest_path.exists() else {}
    started = time.monotonic()
    compile_native()
    if not args.refresh:
        manifest["runtime"] = copy_runtime(framework_source, framework_target)
        python_framework = frameworks / "Python.framework"
        for relative, target in [
            ("Versions/Current", "3.14"),
            ("Python", "Versions/Current/Python"),
            ("Resources", "Versions/Current/Resources"),
        ]:
            link = python_framework / relative
            if link.is_symlink() or link.exists():
                if link.is_dir() and not link.is_symlink():
                    shutil.rmtree(link)
                else:
                    link.unlink()
            link.symlink_to(target)
        manifest["linkAudit"] = relocate_libraries(framework_source, framework_target, frameworks)
    elif not (framework_target / "bin" / "python3.14").exists():
        raise RuntimeError("--refresh requires an existing bundled Python runtime.")
    copy_application(require_complete=not args.runtime_only)
    sign_app(sign_runtime=not args.refresh)
    manifest["runtimeSmoke"] = runtime_smoke()
    manifest["app"] = str(APP)
    manifest["sourceRoot"] = str(PROJECT)
    manifest["buildSeconds"] = round(time.monotonic() - started, 2)
    manifest["sourceReady"] = not args.runtime_only
    manifest["builtAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    manifest["appAllocatedKiB"] = int(run(["/usr/bin/du", "-sk", APP]).stdout.split()[0])
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    say(json.dumps({"app": str(APP), "seconds": manifest["buildSeconds"],
                    "sizeMiB": round(manifest["appAllocatedKiB"] / 1024, 1),
                    "sourceReady": manifest["sourceReady"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stdout or "", file=sys.stderr)
        print(error.stderr or "", file=sys.stderr)
        raise
