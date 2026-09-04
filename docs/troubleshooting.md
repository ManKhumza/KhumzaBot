# NOC AI Assistant - Troubleshooting Guide

## Quick Diagnostics

### Health Check Endpoints
```bash
# Backend health (no auth required)
curl http://127.0.0.1:<port>/health
curl http://127.0.0.1:<port>/health/ready
curl http://127.0.0.1:<port>/health/live
```

### Log Files
| Component | Location |
|-----------|----------|
| Electron | `%LOCALAPPDATA%\NOC AI Assistant\logs\desktop-<date>.log` |
| Backend | `%LOCALAPPDATA%\NOC AI Assistant\logs\backend-<date>.log` |
| Inference | `%LOCALAPPDATA%\NOC AI Assistant\logs\inference-<date>.log` |
| Ingestion | `%LOCALAPPDATA%\NOC AI Assistant\logs\ingestion-<date>.log` |
| Audit | `%LOCALAPPDATA%\NOC AI Assistant\logs\audit-<date>.log` |

## Common Issues

### 1. Application Won't Start

#### Symptoms
- Splash screen appears but closes
- "Backend Error" banner shown
- Blank white window

#### Diagnosis
```powershell
# Check if backend process exists
Get-Process | Where-Object {$_.ProcessName -like "*nocai-backend*"}

# Check port binding
netstat -ano | findstr :<port>

# Check logs
Get-Content "%LOCALAPPDATA%\NOC AI Assistant\logs\backend-*.log" -Tail 50
```

#### Solutions
| Cause | Fix |
|-------|-----|
| Port in use | Restart app (picks new port) |
| Missing llama-server.exe | Verify `runtimes/llama/llama-server.exe` exists |
| Database locked | Delete `nocai.db-wal` and `nocai.db-shm` |
| Corrupted database | Restore from backup |
| Antivirus blocking | Add exclusion for install directory |

### 2. Backend Crashes on Startup

#### Symptoms
- "Backend Crashed" notification
- Repeated restart attempts

#### Diagnosis
```powershell
# Check backend stderr
Get-Content "%LOCALAPPDATA%\NOC AI Assistant\logs\backend-*.log" -Tail 100
```

#### Common Errors
| Error | Cause | Fix |
|-------|-------|-----|
| `ModuleNotFoundError: sqlite_vec` | Extension not bundled | Rebuild with PyInstaller |
| `llama-server: not found` | Binary missing | Copy to `runtimes/llama/` |
| `CUDA out of memory` | GPU VRAM full | Reduce GPU layers or model size |
| `Address already in use` | Port conflict | Restart app |

### 3. Model Loading Issues

#### Model Stays in "STARTING"

```powershell
# Check llama-server logs
Get-Content "%LOCALAPPDATA%\NOC AI Assistant\logs\inference-*.log" -Tail 50
```

| Issue | Fix |
|-------|-----|
| Model file not found | Verify path in database |
| Invalid GGUF | Re-import model |
| Insufficient RAM | Use smaller model/quantization |
| GPU OOM | Reduce `-ngl` or use CPU only |
| Context too large | Reduce context length |

#### Model Shows "FAILED"
- Check `validation_error` in database
- Verify file integrity (SHA-256)
- Try re-importing

#### Model Compatibility Warnings
| Rating | Meaning | Action |
|--------|---------|--------|
| RECOMMENDED | Fits easily | None |
| COMPATIBLE | Fits with margin | Monitor |
| LIMITED | Tight fit | Close other apps |
| NOT_RECOMMENDED | May swap | Use smaller model |
| UNSUPPORTED | Won't fit | Cannot load |

### 4. Chat/Generation Problems

#### Generation Stops Early
| Cause | Fix |
|-------|-----|
| Max tokens reached | Increase `max_tokens` |
| Stop sequence hit | Check stop sequences |
| Context overflow | Reduce history/context |
| Model crashed | Check inference logs |

#### Slow Generation
| Optimization | Impact |
|--------------|--------|
| Increase GPU layers (`-ngl`) | High (if GPU available) |
| Reduce context length | Medium |
| Use smaller quantization | High |
| Increase threads (CPU) | Low-Medium |

#### Citations Missing
- Ensure knowledge collection selected
- Verify documents are "Ready" status
- Check embedding model is active
- Re-process documents if needed

### 5. Document Ingestion Failures

#### Stuck in "PARSING"
| Format | Issue | Fix |
|--------|-------|-----|
| PDF | Scanned/no text | OCR required (not included) |
| DOCX | Corrupted | Re-save in Word |
| HTML | Malformed | Clean HTML first |

#### Failed with Error
| Error | Fix |
|-------|-----|
| `File hash mismatch` | File modified after upload |
| `Unsupported MIME type` | Check file extension |
| `Embedding failed` | Check embedding model active |
| `Vector store error` | Check sqlite-vec extension |

#### Slow Ingestion
- Reduce chunk size
- Batch smaller files
- Ensure embedding model on GPU

### 6. Search/RAG Issues

#### No Results Found
- Verify collection has "Ready" documents
- Check embedding model matches collection
- Try lowering similarity threshold
- Use hybrid search (α=0.5)

#### Irrelevant Results
- Increase `top_k`
- Adjust hybrid α (0.5 default)
- Enable reranking
- Check chunk size appropriate

#### Permission Errors
- Verify user has collection access
- Check collection visibility
- Admin: grant Read permission

### 7. Authentication Problems

#### Login Fails
| Issue | Fix |
|-------|-----|
| "Invalid username/password" | Check caps lock, try reset |
| "Account locked" | Wait 15 min or admin unlock |
| "Must change password" | Complete password change flow |
| Session expires | Increase timeout in settings |

#### Session Token Errors
- Restart application (generates new token)
- Check system clock sync
- Verify backend port accessible

### 8. Database Issues

#### Database Locked
```powershell
# Kill any remaining processes
Stop-Process -Name "nocai-backend" -Force

# Delete WAL files
Remove-Item "%APPDATA%\NOC AI Assistant\data\nocai.db-wal"
Remove-Item "%APPDATA%\NOC AI Assistant\data\nocai.db-shm"
```

#### Migration Failures
```sql
-- Check schema version
SELECT * FROM schema_version;

-- Manual rollback (backup first!)
-- Restore from backup
```

#### Corruption
```powershell
# Integrity check
sqlite3 "%APPDATA%\NOC AI Assistant\data\nocai.db" "PRAGMA integrity_check;"

# If corrupted: restore from backup
```

### 9. Performance Problems

#### High Memory Usage
```powershell
# Check model memory
# Reduce active model size
# Close other applications
# Reduce context length
```

#### High CPU Usage
- Normal during generation
- Persistent high = stuck process
- Restart backend

#### Disk I/O
- Move data to SSD
- Disable antivirus scanning on data dir
- Reduce log level

### 10. Network/Port Issues

#### Port Conflicts
```powershell
# Find process using port
netstat -ano | findstr :<port>
taskkill /PID <pid> /F
```

#### Firewall/Antivirus
- Allow `nocai-backend.exe` outbound (localhost only)
- Exclude data directory from scanning
- Windows Defender: Add exclusion for `%APPDATA%\NOC AI Assistant\`

## Diagnostic Commands

### System Info
```powershell
# OS
systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type"

# Hardware
wmic computersystem get TotalPhysicalMemory
wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors
wmic path win32_VideoController get Name,AdapterRAM,DriverVersion
```

### Process Info
```powershell
# Backend process
Get-Process -Name "nocai-backend" | Select-Object Id, CPU, WS, Handles

# llama.cpp processes
Get-Process -Name "llama-server" | Select-Object Id, CPU, WS
```

### Port Check
```powershell
# List all listening ports
netstat -ano | findstr LISTENING

# Test backend port
Test-NetConnection -ComputerName 127.0.0.1 -Port <port>
```

### File Verification
```powershell
# Check model files
Get-ChildItem "%APPDATA%\NOC AI Assistant\models" -Recurse -Filter "*.gguf" | 
  Select-Object Name, Length, FullName

# Check database
sqlite3 "%APPDATA%\NOC AI Assistant\data\nocai.db" ".tables"
sqlite3 "%APPDATA%\NOC AI Assistant\data\nocai.db" "SELECT COUNT(*) FROM models;"
```

## Getting Help

### Information to Collect
1. Application version (Help → About)
2. OS version (`systeminfo`)
3. Relevant log files (last 100 lines)
4. Steps to reproduce
5. Expected vs actual behavior
6. Hardware specs (CPU, RAM, GPU)

### Diagnostic Export
**Settings → Diagnostics → Export Diagnostics**
Creates a sanitized package with:
- System information
- Configuration (no secrets)
- Recent logs
- Health status
- Database statistics

### Log Levels
Change in **Settings → Diagnostics → Log Level**:
- `DEBUG` - Verbose (development)
- `INFO` - Normal operations
- `WARN` - Potential issues
- `ERROR` - Failures only

## Emergency Procedures

### Complete Reset
```powershell
# 1. Uninstall application
# 2. Remove data (if desired)
Remove-Item "%APPDATA%\NOC AI Assistant" -Recurse -Force
Remove-Item "%LOCALAPPDATA%\NOC AI Assistant" -Recurse -Force

# 3. Reinstall
# 4. Restore from backup if needed
```

### Force Logout All Users
```sql
-- In SQLite
UPDATE sessions SET revoked_at = datetime('now');
```

### Disable Problematic Model
```sql
UPDATE models SET status = 'error' WHERE id = '<model-id>';
```

## Contact Information

When reporting issues, include:
- Diagnostic export file
- Application version
- OS and hardware details
- Steps to reproduce
- Log excerpts