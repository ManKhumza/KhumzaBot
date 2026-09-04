# NOC AI Assistant - Administrator Guide

## Overview

This guide covers administrative tasks for managing NOC AI Assistant in a multi-user environment.

## User Management

### Roles

| Role | Permissions |
|------|-------------|
| **Administrator** | Full system access: manage users, roles, models, all knowledge, audit, settings |
| **Knowledge Manager** | Create collections, upload/process documents, manage collection permissions, chat |
| **Operator** | Chat, search permitted knowledge, view own conversations |

### Creating Users
1. Go to **Administration → Users**
2. Click **Add User**
3. Enter username, password (min 12 chars), display name, email
4. Assign roles
5. User must change password on first login

### User States
- **Active** - Normal access
- **Inactive** - Cannot login
- **Locked** - Too many failed attempts (15 min default)

### Password Policy
- Minimum 12 characters
- Special characters required
- Argon2id hashing (memory=64MB, time=3, parallelism=4)
- Session timeout: 8 hours default

## Model Management

### Importing Models
Administrators can import models for all users:
1. **Models → Scan Directory** - Point to shared model repository
2. **Models → Import Model** - Single file import
3. Models stored in `%APPDATA%\NOC AI Assistant\models\{chat,embedding}\`

### Default Models
Set default models in **Settings → Models**:
- Default Chat Model
- Default Embedding Model
- New users get these activated automatically

### Hardware Compatibility
Each model shows:
- Estimated RAM/VRAM usage
- Compatibility rating
- Warnings if resources insufficient

## Knowledge Base Administration

### Collections
- **Private** - Owner only (can grant access)
- **Shared** - Specific users/groups
- **Public** - All users (read-only)

### Collection Permissions
| Permission | Capabilities |
|------------|-------------|
| Read | Search, chat with collection |
| Write | Upload, reprocess, delete documents |
| Admin | Manage permissions, delete collection |

### Managing Access
1. Select collection in Knowledge page
2. Click **Permissions** (admin/owner only)
3. Add users with Read/Write/Admin
4. Remove access as needed

### Reindexing
Triggered when:
- Embedding model changed
- Chunking config changed
- Manual reindex requested

Process: Documents re-chunked → re-embedded → re-indexed

## Monitoring & Health

### System Health (Administration → Health)
| Component | Status | Details |
|-----------|--------|---------|
| Backend API | Healthy/Degraded/Unhealthy | HTTP responsiveness |
| Database | Healthy/Degraded/Unhealthy | Query performance |
| Model Runtime | Healthy/Degraded/Unhealthy | llama-server status |
| Embedding Runtime | Healthy/Degraded/Unhealthy | Embedding server status |
| Storage | % used, free GB | Disk space |
| Memory | Used/Available MB | RAM usage |
| Job Workers | Active/Queued | Background tasks |

### Jobs Monitoring (Administration → Jobs)
Track ingestion jobs:
- **Pending** - Waiting for worker
- **Running** - Currently processing
- **Completed** - Success
- **Failed** - Error (view details)
- **Cancelled** - User stopped

Actions: Retry failed, Cancel running

### Audit Log (Administration → Audit)
Security-relevant events:
- Login success/failure
- User/role changes
- Model import/activate/delete
- Document upload/delete
- Collection create/delete
- Permission changes
- Settings changes
- Backup/restore

Filters: Actor, Action, Resource, Date range

## Backup & Recovery

### Backup Contents
| Component | Included | Size |
|-----------|----------|------|
| Database | Always | ~10-50 MB |
| Configuration | Always | < 1 MB |
| Models | Optional | GBs |
| Knowledge documents | Optional | GBs |

### Creating Backup
1. **Settings → Diagnostics → Create Backup**
2. Select components
3. Choose destination
4. Generates `.zip` with manifest

### Backup Format
```
nocai-backup-<timestamp>.zip/
├── manifest.json          # Version, timestamp, components
├── nocai.db              # SQLite database
├── config.json           # Settings
├── models/               # Optional: .gguf files
│   └── <model-id>.gguf
├── knowledge/            # Optional: source documents
│   └── <collection-id>/source/
└── metadata/
    ├── users.json
    ├── collections.json
    └── models.json
```

### Restoring Backup
1. **Settings → Diagnostics → Restore Backup**
2. Select backup file
3. Validates:
   - Manifest exists
   - Version compatibility
   - Database integrity
   - No path traversal
4. Creates safety backup of current state
5. Restores and restarts backend

### Automated Backups
Configure via Windows Task Scheduler:
```powershell
# Daily at 2 AM
$Action = New-ScheduledTaskAction -Execute "NOC AI Assistant.exe" -Argument "--backup --output D:\Backups"
$Trigger = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -TaskName "NOC AI Backup" -Action $Action -Trigger $Trigger
```

## Security Configuration

### Network
- Backend binds to `127.0.0.1` only
- Random port per session
- No outbound connections
- Verified with `netstat` / Process Explorer

### Session Security
- 256-bit random session token
- Constant-time comparison
- SHA-256 token hashes in database
- Automatic expiry (8 hours default)

### File Security
- Extension allowlist: `.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.html`
- MIME type verification
- Max file size: 100 MB
- Path traversal protection
- SHA-256 deduplication

### Audit Trail
All security events logged to `audit_log` table:
- Actor, action, resource, outcome, timestamp
- Sanitized metadata (no passwords/tokens)
- Retention: 1 year default

## Troubleshooting

### Common Issues

#### Backend Won't Start
```
# Check logs
%LOCALAPPDATA%\NOC AI Assistant\logs\backend-*.log

# Common causes:
- Port in use (restart app)
- Missing llama-server.exe
- Database locked (kill other instances)
- Corrupted database (restore backup)
```

#### Model Loading Fails
```
# Check:
1. Model file exists and is valid GGUF
2. Sufficient RAM (see compatibility)
3. llama-server.exe in runtimes/llama/
4. GPU drivers if using CUDA/Vulkan
```

#### Database Errors
```
# WAL mode issues:
- Delete nocai.db-wal and nocai.db-shm
- Restart application

# Migration failures:
- Restore from backup
- Check schema_version table
```

#### Out of Disk Space
```
# Clean up:
1. Delete unused models
2. Remove old collections
3. Clear logs: %LOCALAPPDATA%\NOC AI Assistant\logs\
4. Clear cache: %LOCALAPPDATA%\NOC AI Assistant\Cache\
```

### Log Locations
| Component | Location |
|-----------|----------|
| Desktop (Electron) | `%LOCALAPPDATA%\NOC AI Assistant\logs\desktop-*.log` |
| Backend (FastAPI) | `%LOCALAPPDATA%\NOC AI Assistant\logs\backend-*.log` |
| Inference (llama.cpp) | `%LOCALAPPDATA%\NOC AI Assistant\logs\inference-*.log` |
| Ingestion | `%LOCALAPPDATA%\NOC AI Assistant\logs\ingestion-*.log` |
| Audit | `%LOCALAPPDATA%\NOC AI Assistant\logs\audit-*.log` |

### Diagnostic Export
**Settings → Diagnostics → Export Diagnostics** creates a sanitized package:
- System info (OS, CPU, RAM, GPU)
- Application version
- Configuration (no secrets)
- Recent logs (last 1000 lines)
- Health status
- Database stats

## Upgrading

### In-Place Upgrade
1. Download new installer
2. Run installer (detects existing installation)
3. Preserves data directory
4. Updates binaries and resources

### Version Compatibility
- Database migrations run automatically
- Backward compatible within major version
- Backup recommended before upgrade

### Rollback
1. Uninstall new version
2. Reinstall previous version
3. Data preserved automatically

## Performance Tuning

### Model Inference
| Setting | Recommendation |
|---------|----------------|
| Threads | Physical cores (0 = auto) |
| GPU Layers | Max that fits VRAM (-1 = auto) |
| Context Length | Minimum needed (4096 default) |
| Batch Size | 512 (adjust for VRAM) |

### Embedding Performance
- Batch documents when possible
- Use smaller chunk size for faster embedding
- Enable GPU offload for embedding model

### Database
- WAL mode enabled by default
- Regular vacuum: `PRAGMA vacuum;`
- Index maintenance automatic

## Scaling Considerations

### Single Workstation Limits
- 1 concurrent chat generation
- 2 concurrent embedding jobs
- 1 bulk ingestion job
- ~100K chunks practical limit

### Multi-User
- Role-based isolation
- Per-user conversation history
- Shared models (single load)
- Shared knowledge (with permissions)

### Resource Planning
| Users | RAM | Storage | GPU |
|-------|-----|---------|-----|
| 1-2 | 16 GB | 50 GB | Optional |
| 3-5 | 32 GB | 100 GB | Recommended |
| 5+ | 64 GB | 200 GB | Required |

## Maintenance Checklist

### Daily
- [ ] Check health status
- [ ] Review failed jobs
- [ ] Monitor disk space

### Weekly
- [ ] Review audit log
- [ ] Check backup integrity
- [ ] Update GPU drivers

### Monthly
- [ ] Database vacuum
- [ ] Rotate logs
- [ ] Verify backup restore
- [ ] Check for updates

### Quarterly
- [ ] Full disaster recovery test
- [ ] Review user access
- [ ] Capacity planning