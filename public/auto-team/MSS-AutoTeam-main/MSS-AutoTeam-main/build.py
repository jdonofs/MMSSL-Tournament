import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
BUILD = ROOT / "build"
ENTRY = "main.py"
NAME = "mss-autoteam"
CONFIG_FILES = ["options.json", "teams.json"]


def detect_platform() -> str:
    """Return normalized platform name: windows, macos, or linux."""
    system = platform.system()
    if system == "Windows":
        return "windows"
    elif system == "Darwin":
        return "macos"
    elif system == "Linux":
        return "linux"
    else:
        print(f"Warning: Unknown platform '{system}', treating as linux")
        return "linux"


def clean():
    """Remove old build artifacts."""
    for d in (BUILD, DIST):
        if d.exists():
            print(f"Cleaning {d}")
            shutil.rmtree(d)


def sync_deps():
    """Install dependencies via uv."""
    print("Installing dependencies...")
    subprocess.run(["uv", "sync"], cwd=ROOT, check=True)


def build(plat: str):
    """Run PyInstaller to produce a single-file executable."""
    cmd = [
        "uv",
        "run",
        "pyinstaller",
        "--onefile",
        "--name",
        NAME,
    ]

    # --noconsole hides the console window; only relevant on Windows
    if plat == "windows":
        cmd.append("--noconsole")

    cmd.append(ENTRY)

    print(f"Building for {plat}...")
    print(f"  Command: {' '.join(cmd)}")
    subprocess.run(cmd, cwd=ROOT, check=True)


def copy_configs():
    """Copy config files into dist/."""
    for fname in CONFIG_FILES:
        src = ROOT / fname
        if src.exists():
            print(f"Copying {fname} -> dist/")
            shutil.copy2(src, DIST / fname)
        else:
            print(f"Warning: {fname} not found, skipping")


def main():
    plat = detect_platform()
    print(f"Platform: {plat}")
    print(f"Python:   {sys.version}")
    print()

    clean()
    sync_deps()
    build(plat)
    copy_configs()

    # Determine output binary name
    exe_name = f"{NAME}.exe" if plat == "windows" else NAME
    exe_path = DIST / exe_name
    if exe_path.exists():
        size_mb = exe_path.stat().st_size / (1024 * 1024)
        print()
        print(f"Build complete: {exe_path} ({size_mb:.1f} MB)")
    else:
        print()
        print(f"ERROR: Expected output not found at {exe_path}")
        sys.exit(1)


if __name__ == "__main__":
    main()
