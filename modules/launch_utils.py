"""Compatibility shim for extensions expecting A1111-style launch_utils module."""


def git_tag():
    try:
        import launch
        return launch.git_tag()
    except Exception:
        pass
    try:
        import os
        import subprocess
        git = os.environ.get('GIT', "git")
        result = subprocess.run(f"{git} describe --tags --always", capture_output=True, text=True, shell=True)
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return "<none>"
