"""API key management."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .deps import require_auth, state
from .schemas import ApiKeyCreate

router = APIRouter()


@router.get("/apikeys", dependencies=[Depends(require_auth)])
async def list_keys(request: Request) -> dict[str, Any]:
    studio = state(request)
    return {"items": studio.api_keys.list(), "auth_required": studio.settings.auth_required}


@router.post("/apikeys", dependencies=[Depends(require_auth)])
async def create_key(request: Request, payload: ApiKeyCreate) -> dict[str, Any]:
    studio = state(request)
    record, plaintext = studio.api_keys.create(payload.name)
    return {"key": plaintext, "record": {k: v for k, v in record.items() if k != "key_hash"}}


@router.delete("/apikeys/{key_id}", dependencies=[Depends(require_auth)])
async def delete_key(request: Request, key_id: str) -> dict[str, Any]:
    studio = state(request)
    if not studio.api_keys.delete(key_id):
        raise HTTPException(status_code=404, detail="key not found")
    return {"deleted": key_id}
