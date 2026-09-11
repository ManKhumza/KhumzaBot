from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from backend.health.service import health_snapshot

router = APIRouter(tags=["health"])

@router.get("")
async def health(request: Request):
    return await health_snapshot(request.app)

@router.get("/ready")
async def health_ready(request: Request):
    snapshot = await health_snapshot(request.app)
    return JSONResponse(snapshot, status_code=200 if snapshot["ready"] else 503)

@router.get("/live")
async def health_live():
    return {"status": "alive", "service": "nocai-backend"}
