"""One persisted security policy for onboarding, administrators and passwords."""
import string
from fastapi import HTTPException
from backend.db.models import Setting


def security_policy(db):
    from backend.config import get_settings
    settings = get_settings()
    policy = {"passwordMinLength": max(12, settings.password_min_length), "requireSpecialChars": settings.require_special_chars,
              "sessionTimeoutMinutes": settings.session_timeout_minutes, "maxFailedLogins": settings.max_failed_logins,
              "lockoutDurationMinutes": settings.lockout_duration_minutes}
    row = db.query(Setting).filter(Setting.key == "global", Setting.user_id.is_(None)).first()
    if row and isinstance(row.setting_value, dict):
        policy.update(row.setting_value.get("security", {}))
    policy["passwordMinLength"] = max(12, policy["passwordMinLength"])
    return policy


def validate_password(password, db):
    policy = security_policy(db)
    if len(password) < policy["passwordMinLength"] or len(password) > 1024:
        raise HTTPException(400, f"Password must contain {policy['passwordMinLength']} to 1024 characters")
    if policy["requireSpecialChars"] and not any(char in string.punctuation for char in password):
        raise HTTPException(400, "Password must contain a special character")
