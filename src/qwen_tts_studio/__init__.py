"""Qwen3-TTS Studio: local voice design / cloning / speech generation workbench."""

__version__ = "0.1.0"


def main() -> None:
    from .cli import main as _main

    _main()
