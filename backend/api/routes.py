from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.orm import Session
from typing import Literal, Optional
from copy import deepcopy
import json

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import Setting, User
from backend.config import get_settings

router = APIRouter(tags=["settings"])

class SettingsResponse(BaseModel):
    appearance: dict
    models: dict
    knowledge: dict
    behavior: dict
    storage: dict
    security: dict
    diagnostics: dict

class SettingsUpdateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AppearanceSettingsUpdate(SettingsUpdateModel):
    theme: Optional[Literal["light", "dark", "system"]] = None
    language: Optional[str] = Field(None, min_length=2, max_length=16)
    sidebarCollapsed: Optional[bool] = None
    compactMode: Optional[bool] = None


class ModelSettingsUpdate(SettingsUpdateModel):
    defaultChatModelId: Optional[str] = Field(None, max_length=100)
    defaultEmbeddingModelId: Optional[str] = Field(None, max_length=100)
    modelDirectory: Optional[str] = Field(None, max_length=4096)
    defaultContextLength: Optional[int] = Field(None, ge=256, le=1_048_576)
    defaultThreads: Optional[int] = Field(None, ge=0, le=512)
    defaultGpuLayers: Optional[int] = Field(None, ge=-1, le=10_000)


class KnowledgeSettingsUpdate(SettingsUpdateModel):
    defaultChunkSize: Optional[int] = Field(None, ge=64, le=8192)
    defaultChunkOverlap: Optional[int] = Field(None, ge=0, le=4096)
    defaultTopK: Optional[int] = Field(None, ge=1, le=100)
    hybridAlpha: Optional[float] = Field(None, ge=0, le=1)
    enableReranking: Optional[bool] = None
    rerankerModelId: Optional[str] = Field(None, max_length=100)

    @model_validator(mode="after")
    def overlap_must_be_smaller_than_chunk(self):
        if (
            self.defaultChunkSize is not None
            and self.defaultChunkOverlap is not None
            and self.defaultChunkOverlap >= self.defaultChunkSize
        ):
            raise ValueError("defaultChunkOverlap must be smaller than defaultChunkSize")
        return self


class BehaviorSettingsUpdate(SettingsUpdateModel):
    systemInstructions: Optional[str] = Field(None, max_length=12_000)
    responseMode: Optional[Literal["knowledge_only", "knowledge_preferred", "model_only"]] = None
    knowledgeScope: Optional[Literal["selected_collection", "all_collections"]] = None
    citationStyle: Optional[Literal["inline", "sources_list", "inline_and_sources"]] = None
    noKnowledgeResponse: Optional[str] = Field(None, min_length=1, max_length=1_000)
    maxSources: Optional[int] = Field(None, ge=1, le=20)
    minimumRelevanceScore: Optional[float] = Field(None, ge=0, le=1)

    @field_validator("noKnowledgeResponse")
    @classmethod
    def no_knowledge_response_must_not_be_blank(cls, value):
        if value is not None and not value.strip():
            raise ValueError("noKnowledgeResponse must not be blank")
        return value


class StorageSettingsUpdate(SettingsUpdateModel):
    dataLocation: Optional[str] = Field(None, max_length=4096)
    modelStorage: Optional[str] = Field(None, max_length=4096)
    knowledgeStorage: Optional[str] = Field(None, max_length=4096)


class SecuritySettingsUpdate(SettingsUpdateModel):
    sessionTimeoutMinutes: Optional[int] = Field(None, ge=5, le=10_080)
    maxFailedLogins: Optional[int] = Field(None, ge=1, le=100)
    lockoutDurationMinutes: Optional[int] = Field(None, ge=1, le=1440)
    passwordMinLength: Optional[int] = Field(None, ge=8, le=128)
    requireSpecialChars: Optional[bool] = None


class DiagnosticsSettingsUpdate(SettingsUpdateModel):
    logLevel: Optional[Literal["debug", "info", "warning", "error"]] = None
    enableTelemetry: Optional[bool] = None
    autoCheckUpdates: Optional[bool] = None
    debugMode: Optional[bool] = None


class UpdateSettingsRequest(SettingsUpdateModel):
    appearance: Optional[AppearanceSettingsUpdate] = None
    models: Optional[ModelSettingsUpdate] = None
    knowledge: Optional[KnowledgeSettingsUpdate] = None
    behavior: Optional[BehaviorSettingsUpdate] = None
    storage: Optional[StorageSettingsUpdate] = None
    security: Optional[SecuritySettingsUpdate] = None
    diagnostics: Optional[DiagnosticsSettingsUpdate] = None

DEFAULT_SETTINGS = {
    "appearance": {
        "theme": "system",
        "language": "en",
        "sidebarCollapsed": False,
        "compactMode": False,
    },
    "models": {
        "defaultChatModelId": None,
        "defaultEmbeddingModelId": None,
        "modelDirectory": "",
        "defaultContextLength": 4096,
        "defaultThreads": 0,
        "defaultGpuLayers": -1,
    },
    "knowledge": {
        "defaultChunkSize": 384,
        "defaultChunkOverlap": 50,
        "defaultTopK": 10,
        "hybridAlpha": 0.5,
        "enableReranking": False,
        "rerankerModelId": None,
    },
    "behavior": {
        "systemInstructions": (
            "Act as a careful NOC operations assistant. Be concise, state uncertainty, "
            "and never invent operational facts."
        ),
        "responseMode": "knowledge_only",
        "knowledgeScope": "selected_collection",
        "citationStyle": "inline_and_sources",
        "noKnowledgeResponse": (
            "I could not find enough relevant information in the configured knowledge source to answer that."
        ),
        "maxSources": 5,
        "minimumRelevanceScore": 0.55,
    },
    "storage": {
        "dataLocation": "",
        "modelStorage": "",
        "knowledgeStorage": "",
    },
    "security": {
        "sessionTimeoutMinutes": 480,
        "maxFailedLogins": 5,
        "lockoutDurationMinutes": 15,
        "passwordMinLength": 12,
        "requireSpecialChars": True,
    },
    "diagnostics": {
        "logLevel": "info",
        "enableTelemetry": False,
        "autoCheckUpdates": False,
        "debugMode": False,
    },
}

def _merge_settings(base: dict, updates: dict) -> dict:
    result = deepcopy(base) if isinstance(base, dict) else deepcopy(DEFAULT_SETTINGS)
    if not isinstance(updates, dict):
        return result
    for section, values in updates.items():
        if section in result and isinstance(result[section], dict) and isinstance(values, dict):
            result[section] = {**result[section], **values}
    return result


def load_effective_settings(db: Session, current_user: User) -> dict:
    """Return fresh global settings with the current user's permitted overrides."""
    result = deepcopy(DEFAULT_SETTINGS)
    settings_row = db.query(Setting).filter(Setting.key == "global", Setting.user_id.is_(None)).first()
    if settings_row:
        result = _merge_settings(result, settings_row.setting_value)

    user_settings = db.query(Setting).filter(Setting.user_id == current_user.id).all()
    for setting in user_settings:
        if setting.key == "behavior":
            continue
        if setting.key in result and isinstance(setting.setting_value, dict):
            result[setting.key] = {**result[setting.key], **(setting.setting_value or {})}
    return result


@router.get("/settings", response_model=SettingsResponse)
async def get_settings(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    return SettingsResponse(**load_effective_settings(db, current_user))

@router.patch("/settings", response_model=SettingsResponse)
async def update_settings(
    request: UpdateSettingsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    updates = request.model_dump(exclude_unset=True, exclude_none=True)
    is_administrator = "administrator" in current_user.roles
    if "behavior" in updates and not is_administrator:
        raise HTTPException(403, "Only administrators can change assistant behavior")
    if is_administrator:
        settings_row = db.query(Setting).filter(Setting.key == "global", Setting.user_id.is_(None)).first()
        if not settings_row:
            settings_row = Setting(key="global", user_id=None, setting_value=deepcopy(DEFAULT_SETTINGS))
            db.add(settings_row)
        settings_row.setting_value = _merge_settings(settings_row.setting_value or DEFAULT_SETTINGS, updates)
    else:
        for key, value in updates.items():
            setting = db.query(Setting).filter(Setting.key == key, Setting.user_id == current_user.id).first()
            if not setting:
                setting = Setting(key=key, user_id=current_user.id, setting_value=value)
                db.add(setting)
            else:
                setting.setting_value = {**(setting.setting_value or {}), **value}
    
    db.commit()
    
    return await get_settings(current_user, db)
