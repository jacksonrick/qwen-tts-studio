"""Command line entry point: serve the studio on a single port."""

from __future__ import annotations

import argparse
import threading
import webbrowser
from pathlib import Path

from .config import APP_NAME, Paths, Settings, resolve_data_dir, runtime_info


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="qwen-tts-studio", description=f"{APP_NAME} 本地工作台")
    parser.add_argument("--host", default=None, help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 8000）")
    parser.add_argument("--data-dir", default=None, help="数据目录（默认 ./data）")
    parser.add_argument("--backend", default=None, choices=["auto", "ggml", "torch"], help="推理后端")
    parser.add_argument("--quant", default=None, help="GGUF 量化档位：BF16/Q8_0/Q4_K_M/F32")
    parser.add_argument("--no-browser", action="store_true", help="启动时不自动打开浏览器")
    parser.add_argument("--log-level", default="info", choices=["critical", "error", "warning", "info", "debug"])
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    data_root = resolve_data_dir(args.data_dir)
    settings = Settings.load(data_root)
    settings.data_dir = str(data_root)
    if args.host:
        settings.host = args.host
    if args.port:
        settings.port = args.port
    if args.backend:
        settings.backend = args.backend
    if args.quant:
        settings.quant = args.quant

    paths = Paths.create(Path(data_root))

    from .app import create_app  # noqa: PLC0415 - keep import cost out of `import qwen_tts_studio`

    app = create_app(settings, paths)
    runtime = runtime_info(settings.backend)
    print(f"{APP_NAME} → http://{settings.host}:{settings.port}  (backend={runtime.backend}, device={runtime.device}, quant={settings.quant})")
    for warning in runtime.warnings:
        print(f"  ! {warning}")

    if settings.auto_open_browser and not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://{settings.host}:{settings.port}")).start()

    import uvicorn  # noqa: PLC0415

    uvicorn.run(app, host=settings.host, port=settings.port, log_level=args.log_level, access_log=False)
