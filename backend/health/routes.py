from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from backend.auth.dependencies import get_db, get_current_user, require_permission

router = APIRouter(tags=["health"])

@router.get("")
async def health():
    return {"status": "ok", "service": "nocai-backend"}

@router.get("/ready")
async def health_ready():
    return {"status": "ready", "service": "nocai-backend"}

@router.get("/live")
async def health_live():
    return {"status": "alive", "service": "nocai-backend"}