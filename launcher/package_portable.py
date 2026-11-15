"""Build the self-extracting Windows executable from the two launchers and bundle."""

import argparse
from copy import copy
from pathlib import Path, PureWindowsPath
import shutil
import stat
import struct
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
PREFIX = "LyricFrame/"
RUNTIME_PREFIXES = (PREFIX + "node_modules/", PREFIX + "runtime/")
REQUIRED_RUNTIMES = {
    PREFIX + "node_modules/hyperframes/package.json",
    PREFIX + "node_modules/busboy/package.json",
    PREFIX + "runtime/ffmpeg.exe",
    PREFIX + "runtime/ffprobe.exe",
    PREFIX + "runtime/node.exe",
}


def verify_gui_executable(path):
    with path.open("rb") as binary:
        header = binary.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError(f"Expected a Windows executable at {path}")
        binary.seek(struct.unpack_from("<I", header, 60)[0])
        pe = binary.read(96)
        if (len(pe) != 96 or pe[:4] != b"PE\0\0"
                or struct.unpack_from("<H", pe, 4)[0] != 0x8664
                or struct.unpack_from("<H", pe, 24)[0] != 0x20B
                or struct.unpack_from("<H", pe, 92)[0] != 2):
            raise ValueError(f"Expected a Windows x64 GUI executable at {path}")


def validate_runtime_entry(entry):
    parts = entry.filename.removesuffix("/").split("/")
    if any(
        not part.isascii() or not part or part.endswith((".", " "))
        or PureWindowsPath(part).is_reserved()
        or any(character in '<>:"\\|?*' or ord(character) < 32 for character in part)
        for part in parts
    ):
        raise ValueError(f"Unsafe Windows bundle path {entry.filename!r}")
    kind = stat.S_IFMT(entry.external_attr >> 16)
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise ValueError(f"Unsupported bundle entry {entry.filename!r}")
    if entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
        raise ValueError(f"Unsupported ZIP compression for {entry.filename!r}")


def build_payload(path, runtime_bundle, launcher):
    with ZipFile(runtime_bundle) as runtime, ZipFile(path, "w", ZIP_DEFLATED, allowZip64=False) as payload:
        entries = [entry for entry in runtime.infolist() if entry.filename.startswith(RUNTIME_PREFIXES)]
        names = {entry.filename.casefold().rstrip("/") for entry in entries}
        if len(names) != len(entries) or not {name.casefold() for name in REQUIRED_RUNTIMES} <= names:
            raise ValueError("Expected a complete Windows portable ZIP with Node, FFmpeg and Node dependencies")
        for entry in entries:
            validate_runtime_entry(entry)
            with runtime.open(entry) as source, payload.open(copy(entry), "w") as target:
                shutil.copyfileobj(source, target)

        files = [ROOT / name for name in ("server.mjs", "renderer.mjs", "hyper-renderer.mjs", "package.json")]
        for directory in ("fonts", "licenses", "web"):
            files.extend(sorted(path for path in (ROOT / directory).rglob("*") if path.is_file()))
        for file in files:
            payload.write(file, PREFIX + file.relative_to(ROOT).as_posix())
        payload.write(launcher, PREFIX + "LyricFrame.exe")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stub", required=True, type=Path, help="compiled self-extracting launcher")
    parser.add_argument("--launcher", required=True, type=Path, help="compiled desktop launcher")
    parser.add_argument("--runtime-zip", required=True, type=Path, help="Windows x64 bundle with runtime and node_modules")
    parser.add_argument("--output", required=True, type=Path, help="resulting LyricFrame.exe")
    args = parser.parse_args()

    verify_gui_executable(args.stub)
    verify_gui_executable(args.launcher)
    if args.output.resolve() in {path.resolve() for path in (args.stub, args.launcher, args.runtime_zip)}:
        parser.error("the output must be a separate file")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=args.output.parent, prefix=".lyricframe-") as temp:
        payload = Path(temp) / "payload.zip"
        build_payload(payload, args.runtime_zip, args.launcher)
        executable = Path(temp) / "LyricFrame.exe"
        with executable.open("wb") as target:
            for input_file in (args.stub, payload):
                with input_file.open("rb") as source:
                    shutil.copyfileobj(source, target)
            target.write(struct.pack("<Q8s", payload.stat().st_size, b"LYRICZIP"))
        executable.replace(args.output)


if __name__ == "__main__":
    main()
