from fastapi import APIRouter, Depends, HTTPException, Request
from datetime import datetime
from sqlalchemy.orm import Session
from typing import Optional
from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import IngestionJob, User, Document

router = APIRouter(tags=["jobs"])

@router.get("")
async def list_jobs(
    status: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    current_user: User = Depends(require_permission("admin:jobs")),
    db: Session = Depends(get_db)
):
    query = db.query(IngestionJob)
    if status:
        query = query.filter(IngestionJob.status == status)
    jobs = query.order_by(IngestionJob.created_at.desc()).offset(offset).limit(limit).all()
    return [
        {
            "id": job.id,
            "documentId": job.document_id,
            "collectionId": job.collection_id,
            "status": job.status,
            "priority": job.priority,
            "currentStage": job.current_stage,
            "progress": job.progress,
            "errorMessage": job.error_message,
            "startedAt": job.started_at.isoformat() if job.started_at else None,
            "completedAt": job.completed_at.isoformat() if job.completed_at else None,
            "createdAt": job.created_at.isoformat() if job.created_at else "",
        }
        for job in jobs
    ]


@router.get("/{job_id}")
async def get_job(
    job_id: str,
    current_user: User = Depends(require_permission("admin:jobs")),
    db: Session = Depends(get_db),
):
    """Return one durable ingestion job."""
    job = db.get(IngestionJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return {
        "id": job.id,
        "documentId": job.document_id,
        "collectionId": job.collection_id,
        "status": job.status,
        "priority": job.priority,
        "currentStage": job.current_stage,
        "progress": job.progress,
        "errorMessage": job.error_message,
        "startedAt": job.started_at.isoformat() if job.started_at else None,
        "completedAt": job.completed_at.isoformat() if job.completed_at else None,
        "createdAt": job.created_at.isoformat() if job.created_at else "",
    }

@router.post("/{job_id}/retry")
async def retry_job(
    job_id: str,
    request: Request,
    current_user = Depends(require_permission("admin:jobs")),
    db: Session = Depends(get_db)
):
    job = db.query(IngestionJob).filter(IngestionJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status not in ("failed", "cancelled"):
        raise HTTPException(400, f"Cannot retry job with status '{job.status}'")
    job.status = "pending"
    job.error_message = None
    job.started_at = None
    job.completed_at = None
    job.current_stage = "queued"
    job.progress = 0
    document = db.get(Document, job.document_id)
    if document:
        document.status = "queued"
        document.error_message = None
    db.commit()
    await request.app.state.ingestion.enqueue(job.id)
    return {"success": True}

@router.post("/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    current_user = Depends(require_permission("admin:jobs")),
    db: Session = Depends(get_db)
):
    job = db.query(IngestionJob).filter(IngestionJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status not in ("pending", "running"):
        raise HTTPException(400, f"Cannot cancel job with status '{job.status}'")
    job.status = "cancelled"
    job.current_stage = "cancelled"
    job.error_message = "Cancelled by user"
    job.completed_at = datetime.utcnow()
    document = db.get(Document, job.document_id)
    if document:
        document.status = "cancelled"
        document.error_message = "Ingestion cancelled; retry to index this document"
    db.commit()
    return {"success": True}
