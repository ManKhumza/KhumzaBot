# NOC AI Assistant - Release Verification

## Pre-Release Checklist

### Code Quality
- [ ] All TypeScript strict checks pass (`npm run typecheck`)
- [ ] ESLint passes (`npm run lint`)
- [ ] Python type hints valid (`mypy backend/`)
- [ ] Unit tests pass (`pytest backend/tests/`)
- [ ] Integration tests pass

### Security
- [ ] CSP headers configured
- [ ] No `eval()` or `Function()` in renderer
- [ ] `contextIsolation: true` in Electron
- [ ] `nodeIntegration: false` in Electron
- [ ] Session token validation on all endpoints
- [ ] Argon2id parameters: memory≥64MB, time≥3
- [ ] Path traversal protection
- [ ] File type validation (extension + MIME)
- [ ] No outbound network calls in production

### Functionality
- [ ] Authentication flow works
- [ ] Role-based access control enforced
- [ ] Model import/scan/activate works
- [ ] Document upload/processing works
- [ ] Chat streaming works
- [ ] Citations appear correctly
- [ ] Search returns results
- [ ] Admin functions work
- [ ] Settings persist
- [ ] Backup/restore works

### Packaging
- [ ] NSIS installer builds
- [ ] Portable ZIP builds
- [ ] SHA256 checksums generated
- [ ] Installer tested on clean Windows 10/11
- [ ] Portable version tested
- [ ] Uninstall preserves data by default
- [ ] Code signing verified (production)

---

## Clean Machine Installation Test

### Test Environment
- Fresh Windows 10/11 VM (no dev tools)
- No Node.js, Python, Visual Studio
- No llama.cpp, PostgreSQL, Docker
- Standard user account (non-admin)

### Test Procedure

#### 1. Install
```powershell
# Run installer
.\NOC-AI-Assistant-Setup-1.0.0.exe

# Verify:
# - Installation completes without errors
# - Start Menu shortcut created
# - Desktop shortcut created (if selected)
# - Installation directory populated
```

#### 2. First Launch
```powershell
# Launch from Start Menu
# Verify:
# - Splash screen appears
# - Backend starts (within 30 seconds)
# - Login screen appears
# - No console windows visible
```

#### 3. Login & Setup
```powershell
# Login with default credentials
# Username: admin
# Password: ChangeMe123!
# Verify:
# - Forced password change
# - Dashboard loads
# - System health shows "Healthy"
```

#### 4. Model Import
```powershell
# Go to Models page
# Click "Scan Directory" or "Import Model"
# Select a local GGUF file
# Verify:
# - Model detected and validated
# - Hardware compatibility shown
# - Import succeeds
# - Model appears in list
```

#### 5. Model Activation
```powershell
# Click "Activate" on chat model
# Verify:
# - Status changes to "Active"
# - Loading completes within 30 seconds
# - No console windows appear
```

#### 6. Knowledge Base
```powershell
# Go to Knowledge page
# Create collection
# Upload test documents (.txt, .pdf, .md)
# Verify:
# - Documents process through all stages
# - Status reaches "Ready"
# - Chunk count > 0
```

#### 7. Chat with Knowledge
```powershell
# Go to Chats → New Chat
# Select knowledge collection
# Ask question about documents
# Verify:
# - Streaming response
# - Citations appear
# - Citation preview works
# - Source preview opens
```

#### 8. Model-Only Chat
```powershell
# New chat without knowledge collection
# Verify:
# - "Knowledge: None" indicator
# - Normal LLM responses
# - No citations shown
```

#### 9. Search
```powershell
# Go to Search page
# Enter query
# Verify:
# - Results returned
# - Expand/collapse works
# - Copy button works
```

#### 10. Settings
```powershell
# Change theme (Light/Dark/System)
# Change model parameters
# Verify persistence after restart
```

#### 11. Admin Functions
```powershell
# Login as admin
# Go to Administration
# Verify:
# - User management works
# - Audit log shows events
# - Jobs page shows ingestion jobs
# - Health page shows all green
```

#### 12. Restart Test
```powershell
# Close application completely
# Re-launch from Start Menu
# Verify:
# - No re-login required (session persists)
# - Models still active
# - Conversations preserved
# - Settings preserved
```

#### 13. Reboot Test
```powershell
# Restart Windows VM
# Log in
# Launch application
# Verify all functionality works
```

#### 14. Uninstall Test
```powershell
# Settings → Apps → Uninstall
# Choose "Keep user data"
# Verify:
# - Application removed
# - Start Menu/Desktop shortcuts removed
# - Data directory preserved: %APPDATA%\NOC AI Assistant\
# - Reinstall works
```

---

## Offline Verification

### Network Isolation Test
```powershell
# Disable network adapter
# Or use firewall rule:
New-NetFirewallRule -DisplayName "Block NOC AI" -Direction Outbound -Program "C:\Program Files\NOC AI Assistant\NOC AI Assistant.exe" -Action Block

# Test all functionality:
# - Login
# - Chat
# - Model loading
# - Document processing
# - Search
# - Settings
# - Admin

# Verify: NO outbound connections in Process Monitor / Wireshark
```

### Expected Network Activity
| Component | Connections | Destination |
|-----------|-------------|-------------|
| Electron | None | - |
| Backend | Loopback only | 127.0.0.1:<port> |
| llama.cpp | None | - |
| Total | 1 local connection | 127.0.0.1 |

### Verification Command
```powershell
# Check backend connections
Get-NetTCPConnection -OwningProcess (Get-Process nocai-backend).Id -State Established

# Should show only 127.0.0.1
```

---

## Performance Benchmarks

### Target Metrics
| Metric | Target | Measurement |
|--------|--------|-------------|
| Cold start | < 5 seconds | App launch to UI ready |
| Backend startup | < 10 seconds | Backend process to health ready |
| Model load (7B Q4) | < 15 seconds | Activate to ready |
| First token | < 2 seconds | Chat request to first token |
| Embedding (1 doc) | < 1 second | Single document |
| Vector search (10K) | < 500ms | Top-10 retrieval |
| Hybrid search | < 1 second | Vector + FTS + RRF |

### Test Commands
```powershell
# Measure startup
Measure-Command { Start-Process "NOC AI Assistant.exe" }

# Measure model load
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# Click Activate in UI
$sw.Stop()
$sw.ElapsedMilliseconds

# Measure generation
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# Send chat message
$sw.Stop()
$sw.ElapsedMilliseconds
```

---

## Compatibility Matrix

### Windows Versions
| Version | Supported | Tested |
|---------|-----------|--------|
| Windows 10 21H2+ | Yes | ✅ |
| Windows 11 22H2+ | Yes | ✅ |
| Windows Server 2019+ | Yes | ⚠️ |

### Hardware Requirements
| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 8+ cores |
| RAM | 8 GB | 32 GB |
| GPU | None | NVIDIA RTX 3060+ (8GB VRAM) |
| Disk | 10 GB | 100 GB SSD |
| VRAM | 0 GB | 8+ GB |

### Model Compatibility
| Model Size | Quantization | RAM Needed | GPU VRAM |
|------------|-------------|------------|----------|
| 1B | Q4_K_M | ~2 GB | 0 GB |
| 3B | Q4_K_M | ~4 GB | 2 GB |
| 7B | Q4_K_M | ~6 GB | 4 GB |
| 13B | Q4_K_M | ~10 GB | 8 GB |
| 70B | Q4_K_M | ~48 GB | 24+ GB |

---

## Regression Test Suite

### Automated Tests
```powershell
# Backend tests
cd backend
.\.venv\Scripts\pytest.exe tests/ -v --cov=backend

# Frontend tests
cd apps/desktop/renderer
npm test

# E2E tests (if implemented)
# npm run test:e2e
```

### Critical User Flows
1. **Login → Chat → Logout**
2. **Model Import → Activate → Chat**
3. **Collection Create → Upload → Process → Search → Chat**
4. **User Create → Login as User → Chat**
5. **Backup → Restore → Verify Data**

---

## Signing & Distribution Verification

### Code Signing
```powershell
# Verify signature
signtool verify /pa /v "NOC-AI-Assistant-Setup-1.0.0.exe"

# Check timestamp
signtool verify /pa /v /tr http://timestamp.digicert.com "NOC-AI-Assistant-Setup-1.0.0.exe"

# Certificate details
signtool verify /pa /v "NOC-AI-Assistant-Setup-1.0.0.exe" 2>&1 | Select-String "Subject"
```

### Checksum Verification
```powershell
# Verify SHA256SUMS.txt
Get-FileHash -Path "NOC-AI-Assistant-Setup-1.0.0.exe" -Algorithm SHA256
Get-FileHash -Path "NOC-AI-Assistant-Portable-1.0.0.zip" -Algorithm SHA256

# Compare with SHA256SUMS.txt
Get-Content SHA256SUMS.txt
```

### VirusTotal Scan
```powershell
# Upload to VirusTotal (manual)
# Or use VT CLI:
# vt scan file "NOC-AI-Assistant-Setup-1.0.0.exe"
# vt analysis <id>
```

---

## Release Artifacts Checklist

### Required Files
```
dist/
├── NOC-AI-Assistant-Setup-1.0.0.exe      ✅
├── NOC-AI-Assistant-Portable-1.0.0.zip   ✅
├── SHA256SUMS.txt                        ✅
└── RELEASE-NOTES.md                      ✅
```

### SHA256SUMS.txt Format
```
<sha256-hash>  NOC-AI-Assistant-Setup-1.0.0.exe
<sha256-hash>  NOC-AI-Assistant-Portable-1.0.0.zip
```

### RELEASE-NOTES.md Template
```markdown
# NOC AI Assistant 1.0.0

## Highlights
- Initial release
- Local-first AI assistant for NOC environments
- GGUF model support with hardware detection
- Document ingestion with RAG
- Multi-user with RBAC

## New Features
- [Feature 1]
- [Feature 2]

## Bug Fixes
- [Fix 1]

## Known Issues
- [Issue 1]

## Upgrade Notes
- Fresh install required for v1.0.0
```

---

## Post-Release Monitoring

### Metrics to Track
- Installer download count
- Installation success rate (telemetry disabled, use voluntary reports)
- Crash reports (if enabled)
- Common error patterns in logs
- Performance metrics from voluntary diagnostics

### Support Channels
- GitHub Issues for bugs
- Documentation for common issues
- Diagnostic export for complex problems

---

## Rollback Procedure

### If Critical Issue Found
1. **Disable auto-update** (already disabled by default)
2. **Publish hotfix** with incremented patch version
3. **Communicate** via release notes and GitHub
4. **Provide manual uninstall instructions** if needed

### Data Migration
- Database migrations are forward-only
- Downgrade requires backup restore
- Document in release notes