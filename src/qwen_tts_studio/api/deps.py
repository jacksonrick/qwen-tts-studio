"""Shared FastAPI dependencies: app state access and API key auth."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request, WebSocket

LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def state(request: Request) -> Any:
    return request.app.state.studio


def _extract_key(headers: Any) -> str | None:
    api_key = headers.get("x-api-key")
    if api_key:
        return api_key.strip()
    auth = headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def check_auth(request: Request) -> None:
    studio = request.app.state.studio
    if not studio.settings.auth_required:
        return
    client = request.client.host if request.client else ""
    if client in LOOPBACK:
        return
    key = _extract_key(request.headers)
    if not key or not studio.api_keys.verify(key):
        raise HTTPException(status_code=401, detail="invalid or missing API key")


def check_ws_auth(ws: WebSocket) -> bool:
    studio = ws.app.state.studio
    if not studio.settings.auth_required:
        return True
    client = ws.client.host if ws.client else ""
    if client in LOOPBACK:
        return True
    key = _extract_key(ws.headers) or ws.query_params.get("api_key")
    return bool(key and studio.api_keys.verify(key))


def require_auth(request: Request) -> None:
    check_auth(request)
