#!/usr/bin/env python3
"""Build default-theme-only installation archives from an exact Git revision."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import zipfile


def run(*args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD", help="Committed revision to package")
    parser.add_argument("--output", required=True, type=Path, help="Artifact directory")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    commit = run("git", "rev-parse", "--verify", args.ref + "^{commit}", cwd=repo)
    timestamp = int(run("git", "show", "-s", "--format=%ct", commit, cwd=repo))
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lill-release-") as scratch:
        scratch = Path(scratch)
        project = scratch / "lill"
        project.mkdir()
        source = subprocess.check_output(["git", "archive", "--format=tar", commit], cwd=repo)
        archive = scratch / "source.tar"
        archive.write_bytes(source)
        with tarfile.open(archive) as tar:
            for member in tar:
                path = Path(member.name)
                if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                    raise ValueError("Unsupported source archive entry: " + member.name)
                if path.parts[0] == ".superpowers" or path.parts[:2] == ("docs", "superpowers"):
                    continue
                if path.parts[:2] == ("frontend", "themes") and len(path.parts) > 2 and path.parts[2] != "default":
                    raise ValueError("Third-party theme tracked in core: " + member.name)
                if any(part in {".git", ".backup", "node_modules", "uploads", "data", "cache"} for part in path.parts):
                    raise ValueError("Runtime content tracked in core: " + member.name)
                if path.name.startswith(".env") or re.search(r"\.(?:db|sqlite)(?:-\w+)?$", path.name):
                    raise ValueError("Private runtime file tracked in core: " + member.name)
                tar.extract(member, project)

        backend = json.loads((project / "backend/package.json").read_text())
        frontend = json.loads((project / "frontend/package.json").read_text())
        version = backend["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version) or frontend.get("version") != version:
            raise ValueError("Backend and frontend release versions must match")
        names = [f"lill-v{version}.zip", f"lill-v{version}.tar.gz"]
        for name in [*names, "SHA256SUMS"]:
            if (output / name).exists():
                raise FileExistsError(output / name)

        env = {**os.environ, "CI": "1", "ASTRO_TELEMETRY_DISABLED": "1"}
        for command in [
            ["pnpm", "install", "--frozen-lockfile"],
            ["pnpm", "run", "build"],
        ]:
            subprocess.run(command, cwd=project / "frontend", env=env, check=True)
        dist = project / "frontend/dist"
        if sorted(p.name for p in (dist / "themes").iterdir()) != ["default"]:
            raise ValueError("Build output contains an unexpected theme")
        # Keep the full source theme, including its server extension; build output
        # deliberately omits backend/, so never replace it with the public copy.
        for path in dist.iterdir():
            if path.name == "themes":
                continue
            target = project / "frontend" / path.name
            if path.is_dir():
                shutil.copytree(path, target, dirs_exist_ok=True)
            else:
                shutil.copy2(path, target)
        for path in [dist, project / "frontend/node_modules", project / "frontend/.astro"]:
            shutil.rmtree(path, ignore_errors=True)
        for path in project.rglob(".DS_Store"):
            path.unlink()
        required = [
            "frontend/index.html", "frontend/admin/index.html",
            "frontend/admin/login/index.html", "frontend/admin/install/index.html",
            "frontend/api.js", "frontend/theme.js",
            "frontend/themes/default/backend/index.mjs",
            "backend/plugins/hello-world/plugin.json",
        ]
        for name in required:
            if not (project / name).is_file():
                raise ValueError("Missing installation file: " + name)
        (project / "RELEASE.json").write_text(json.dumps({
            "version": version, "commit": commit,
            "source_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp)),
            "node": run("node", "--version", cwd=project),
            "themes": ["default"], "prebuilt_frontend": True,
        }, ensure_ascii=False, indent=2) + "\n")

        paths = [project, *sorted(project.rglob("*"))]
        with zipfile.ZipFile(output / names[0], "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in paths:
                relative = path.relative_to(scratch).as_posix()
                info = zipfile.ZipInfo(relative + ("/" if path.is_dir() else ""), time.gmtime(timestamp)[:6])
                info.external_attr = (0o40755 if path.is_dir() else 0o100644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, b"" if path.is_dir() else path.read_bytes())
        with (output / names[1]).open("wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=timestamp) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as archive:
                    for path in paths:
                        info = archive.gettarinfo(path, arcname=path.relative_to(scratch).as_posix())
                        info.uid = info.gid = 0
                        info.uname = info.gname = ""
                        info.mtime = timestamp
                        info.mode = 0o755 if path.is_dir() else 0o644
                        if path.is_file():
                            with path.open("rb") as content:
                                archive.addfile(info, content)
                        else:
                            archive.addfile(info)
        checksums = [hashlib.sha256((output / name).read_bytes()).hexdigest() + "  " + name for name in names]
        (output / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
        print(json.dumps({"version": version, "commit": commit, "artifacts": [str(output / n) for n in [*names, "SHA256SUMS"]]}, indent=2))


if __name__ == "__main__":
    main()
