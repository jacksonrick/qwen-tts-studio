"""FastAPI application factory: API routes, error handling and static UI hosting."""

from __future__ import annotations

import logging
import logging.handlers
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import apikeys, history, openai_compat, system, tts, voices
from .config import APP_NAME, Paths, Settings
from .engine.base import EngineError
from .studio import Studio

logger = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).parent / "static"
PLACEHOLDER = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Qwen3-TTS Studio</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f14;color:#e6edf3;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{max-width:560px;padding:32px;border:1px solid #253040;border-radius:16px;background:#111823}
code{background:#1b2534;padding:2px 6px;border-radius:6px;font-size:13px}
h1{font-size:18px;font-weight:500;margin:0 0 12px}p{font-size:14px;line-height:1.7;color:#9fb0c4}</style>
</head><body><main><h1>前端尚未构建</h1>
<p>后端已启动。请先构建前端，然后刷新此页：</p>
<p><code>cd frontend &amp;&amp; pnpm install &amp;&amp; pnpm build</code></p>
<p>开发模式可访问 <code>http://127.0.0.1:5173</code>（Vite 会把 /api 与 /ws 代理到本服务）。</p>
</main></body></html>"""


def _setup_logging(logs_dir: Path, level: int = logging.INFO) -> None:
    logs_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    if any(isinstance(handler, logging.handlers.RotatingFileHandler) for handler in root.handlers):
        return
    root.setLevel(level)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file_handler = logging.handlers.RotatingFileHandler(
        logs_dir / "studio.log", maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)
    if not any(isinstance(handler, logging.StreamHandler) for handler in root.handlers):
        stream = logging.StreamHandler()
        stream.setFormatter(formatter)
        root.addHandler(stream)


def create_app(settings: Settings, paths: Paths) -> FastAPI:
    _setup_logging(paths.logs)
    studio = Studio(settings, paths)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        studio.start()
        logger.info("%s %s ready, backend=%s quant=%s data=%s", APP_NAME, __version__, studio.manager.backend, settings.quant, paths.root)
        try:
            yield
        finally:
            studio.stop()

    app = FastAPI(
        title=APP_NAME,
        version=__version__,
        description="本地 Qwen3-TTS 声音设计 / 音色克隆 / 语音生成工作台",
        lifespan=lifespan,
    )
    app.state.studio = studio

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Job-Id", "X-History-Id", "X-Sample-Rate", "X-Ttfa-Ms", "X-Rtf", "X-Duration"],
    )

    @app.middleware("http")
    async def guard_writes(request: Request, call_next):  # type: ignore[no-untyped-def]
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            origin = request.headers.get("origin")
            if origin:
                allowed = {
                    f"http://{request.headers.get('host', '')}",
                    "http://127.0.0.1:5173",
                    "http://localhost:5173",
                }
                if origin not in allowed:
                    return JSONResponse(status_code=403, content={"detail": "origin not allowed"})
        return await call_next(request)

    @app.exception_handler(EngineError)
    async def engine_error_handler(_request: Request, exc: EngineError) -> JSONResponse:
        fatal = {"generation_failed", "model_load_failed", "engine_error"}
        return JSONResponse(
            status_code=500 if exc.code in fatal else 400,
            content={"error": {"code": exc.code, "message": str(exc), "hint": exc.hint}},
        )

    app.include_router(system.router, prefix="/api/v1", tags=["system"])
    app.include_router(tts.router, prefix="/api/v1", tags=["tts"])
    app.include_router(voices.router, prefix="/api/v1", tags=["voices"])
    app.include_router(history.router, prefix="/api/v1", tags=["history"])
    app.include_router(apikeys.router, prefix="/api/v1", tags=["apikeys"])
    app.include_router(openai_compat.router, tags=["openai"])

    @app.get("/api/v1/version", tags=["system"])
    async def version() -> dict[str, Any]:
        return {"app": APP_NAME, "version": __version__}

    if STATIC_DIR.exists() and (STATIC_DIR / "index.html").exists():
        assets = STATIC_DIR / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str) -> Any:
            candidate = STATIC_DIR / full_path
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(STATIC_DIR / "index.html")
    else:

        @app.get("/", include_in_schema=False)
        async def placeholder() -> HTMLResponse:
            return HTMLResponse(PLACEHOLDER)

    return app
