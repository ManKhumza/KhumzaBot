# NOC AI Assistant - Build Guide

## Prerequisites

### Development Environment
- **Windows 10/11** (build host)
- **Visual Studio 2022** with C++ workload
- **Node.js 20+** (LTS)
- **Python 3.11+**
- **Git**
- **CMake 3.22+**
- **CUDA Toolkit 12.x** (optional, for GPU builds)
- **Vulkan SDK** (optional, for GPU builds)

### Required Tools
```powershell
# Verify installations
node --version        # v20.x.x
npm --version         # 10.x.x
python --version      # 3.11.x
cmake --version       # 3.22+
git --version
```

## Repository Structure
```
noc-ai-assistant/
├── apps/
│   └── desktop/
│       ├── electron/          # Electron main process
│       ├── renderer/          # React frontend
│       └── preload/           # IPC preload script
├── backend/
│   ├── main.py               # FastAPI entry point
│   ├── config.py             # Settings
│   ├── pyproject.toml        # Python dependencies
│   └── nocai-backend.spec    # PyInstaller spec
├── runtimes/
│   └── llama/                # llama.cpp binaries
├── resources/
│   ├── icons/                # Application icons
│   └── license.txt           # EULA
├── scripts/
│   ├── build-all.ps1         # Main build script
│   └── download-llama.ps1    # llama.cpp downloader
├── packaging/                # Installer configs
└── docs/                     # Documentation
```

## Building llama.cpp (Required First)

### Windows Build (CPU Only)
```cmd
# Clone specific version
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
git checkout b4401  # Or desired version

# Configure
cmake -B build `
  -DGGML_CUDA=OFF `
  -DGGML_VULKAN=OFF `
  -DCMAKE_BUILD_TYPE=Release

# Build
cmake --build build --config Release --target llama-server llama-cli

# Copy to runtimes
copy build\bin\Release\llama-server.exe ..\..\runtimes\llama\
copy build\bin\Release\llama-cli.exe ..\..\runtimes\llama\
copy build\bin\Release\*.dll ..\..\runtimes\llama\
```

### Windows Build (With CUDA)
```cmd
# Requires CUDA Toolkit 12.x
cmake -B build `
  -DGGML_CUDA=ON `
  -DCMAKE_CUDA_COMPILER="C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.0/bin/nvcc.exe" `
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release --target llama-server llama-cli
```

### Windows Build (With Vulkan)
```cmd
# Requires Vulkan SDK
cmake -B build `
  -DGGML_VULKAN=ON `
  -DVULKAN_SDK="C:/VulkanSDK/1.3.xxx" `
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release --target llama-server llama-cli
```

### Full GPU Build (Recommended for Production)
```cmd
cmake -B build `
  -DGGML_CUDA=ON `
  -DGGML_VULKAN=ON `
  -DGGML_OPENCL=ON `
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release --target llama-server llama-cli
```

### Verify Binaries
```powershell
# Test llama-server
.\runtimes\llama\llama-server.exe --help

# Should show version and available backends
# Look for: CUDA, Vulkan, OpenCL, Metal support indicators
```

## Building Backend (Python)

### Development Setup
```powershell
cd backend

# Create virtual environment
python -m venv .venv
.\.venv\Scripts\activate

# Install dependencies
pip install -e ".[dev]"
pip install pyinstaller
```

### Run in Development
```powershell
# Set required env vars
$env:NOC_AI_SESSION_TOKEN = "test-token-123"
$env:NOC_AI_DATA_DIR = "C:\temp\nocai-test"

# Run
python main.py --port 8080 --token test-token-123 --data-dir "C:\temp\nocai-test"
```

### Build Executable with PyInstaller
```powershell
# Build using spec file
.\.venv\Scripts\pyinstaller.exe nocai-backend.spec --clean --noconfirm

# Output: ../apps/desktop/electron/dist/backend/nocai-backend.exe
```

### Verify Executable
```powershell
# Test standalone executable
$env:NOC_AI_SESSION_TOKEN = "test-token-123"
$env:NOC_AI_DATA_DIR = "C:\temp\nocai-test"
.\dist\nocai-backend.exe --port 8081 --token test-token-123 --data-dir "C:\temp\nocai-test"
```

## Building Frontend (React/TypeScript)

### Development Setup
```powershell
cd apps\desktop\renderer

# Install dependencies
npm ci

# Start dev server
npm run dev
# Runs on http://localhost:5173
```

### Type Checking
```powershell
npm run typecheck
```

### Linting
```powershell
npm run lint
```

### Production Build
```powershell
npm run build
# Output: ../dist/renderer/
```

## Building Electron Application

### Development Setup
```powershell
cd apps\desktop\electron

# Install dependencies
npm ci
```

### Development Mode
```powershell
# Terminal 1: Frontend dev server
cd ..\renderer
npm run dev

# Terminal 2: Electron
cd ..\electron
npm run dev
```

### Package Application
```powershell
cd apps\desktop\electron

# Set version
$version = "1.0.0"
$packageJson = Get-Content package.json | ConvertFrom-Json
$packageJson.version = $version
$packageJson | ConvertTo-Json -Depth 10 | Set-Content package.json

# Build for Windows x64
npx electron-builder --win --x64 --config builder.yaml

# Output: dist/
# - NOC-AI-Assistant-Setup-<version>.exe
# - NOC-AI-Assistant-Portable-<version>.zip
```

## Complete Build Process

### Automated Build Script
```powershell
# From project root
.\scripts\build-all.ps1 -Version "1.0.0"

# Options:
# -SkipBackend       Skip backend build
# -SkipFrontend      Skip frontend build
# -SkipPackaging     Skip electron-builder
```

### Manual Step-by-Step
```powershell
# 1. Build llama.cpp (one-time)
.\scripts\download-llama.ps1
# OR build manually (see above)

# 2. Build backend
cd backend
.\.venv\Scripts\pyinstaller.exe nocai-backend.spec --clean --noconfirm
cd ..

# 3. Build frontend
cd apps\desktop\renderer
npm ci
npm run build
cd ..\..

# 4. Package Electron
cd apps\desktop\electron
npm ci
npx electron-builder --win --x64 --config builder.yaml
cd ..\..

# 5. Generate checksums
$dist = "apps\desktop\electron\dist"
$files = Get-ChildItem $dist -Filter "*.exe", "*.zip" | Where-Object { -not $_.Name.Contains("blockmap") }
$checksums = @()
foreach ($file in $files) {
    $hash = Get-FileHash -Path $file.FullName -Algorithm SHA256
    $checksums += "$($hash.Hash)  $($file.Name)"
}
$checksums -join "`n" | Set-Content "$dist\SHA256SUMS.txt"
```

## Build Artifacts

### Expected Output
```
apps/desktop/electron/dist/
├── NOC-AI-Assistant-Setup-1.0.0.exe      # NSIS Installer (~150-200 MB)
├── NOC-AI-Assistant-Portable-1.0.0.zip   # Portable (~150-200 MB)
├── SHA256SUMS.txt                        # Checksums
└── latest.yml                            # Auto-update (disabled)
```

### Artifact Verification
```powershell
# Verify checksums
Get-Content "apps\desktop\electron\dist\SHA256SUMS.txt"

# Verify installer
# 1. Run installer on clean VM
# 2. Check Start Menu shortcut
# 3. Verify app launches
# 4. Check backend starts
# 4. Test model loading
```

## CI/CD Pipeline (GitHub Actions Example)

```yaml
# .github/workflows/build.yml
name: Build Windows

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: windows-latest
    timeout-minutes: 60
    
    steps:
    - uses: actions/checkout@v4
    
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
        cache-dependency-path: apps/desktop/renderer/package-lock.json
    
    - name: Setup Python
      uses: actions/setup-python@v5
      with:
        python-version: '3.11'
        cache: 'pip'
        cache-dependency-path: backend/pyproject.toml
    
    - name: Install Visual Studio Build Tools
      uses: microsoft/setup-msbuild@v2
    
    - name: Install CMake
      uses: jwlawson/actions-setup-cmake@v2
      with:
        cmake-version: '3.28'
    
    - name: Install CUDA (optional)
      # Add CUDA setup if needed
    
    - name: Build llama.cpp
      run: |
        cd runtimes/llama
        # ... build commands
    
    - name: Build Backend
      run: |
        cd backend
        python -m venv .venv
        .venv\Scripts\pip install -e ".[dev]"
        .venv\Scripts\pip install pyinstaller
        .venv\Scripts\pyinstaller nocai-backend.spec --clean --noconfirm
    
    - name: Build Frontend
      run: |
        cd apps/desktop/renderer
        npm ci
        npm run build
    
    - name: Package Electron
      run: |
        cd apps/desktop/electron
        npm ci
        npx electron-builder --win --x64 --config builder.yaml
    
    - name: Generate Checksums
      run: |
        $dist = "apps/desktop/electron/dist"
        $files = Get-ChildItem $dist -Filter "*.exe", "*.zip" | Where-Object { -not $_.Name.Contains("blockmap") }
        $checksums = @()
        foreach ($file in $files) {
            $hash = Get-FileHash -Path $file.FullName -Algorithm SHA256
            $checksums += "$($hash.Hash)  $($file.Name)"
        }
        $checksums -join "`n" | Set-Content "$dist\SHA256SUMS.txt"
    
    - name: Upload Artifacts
      uses: actions/upload-artifact@v4
      with:
        name: release-artifacts
        path: apps/desktop/electron/dist/*
        retention-days: 30
    
    - name: Create Release
      uses: softprops/action-gh-release@v1
      with:
        files: |
          apps/desktop/electron/dist/NOC-AI-Assistant-Setup-${{ github.ref_name }}.exe
          apps/desktop/electron/dist/NOC-AI-Assistant-Portable-${{ github.ref_name }}.zip
          apps/desktop/electron/dist/SHA256SUMS.txt
        generate_release_notes: true
```

## Code Signing (Production)

### Certificate Setup
```powershell
# 1. Obtain code signing certificate (EV preferred)
# 2. Export to .pfx
# 3. Store securely (Azure Key Vault, GitHub Secrets)

# Configure in builder.yaml:
# win:
#   certificateFile: ${{ secrets.CERT_FILE }}
#   certificatePassword: ${{ secrets.CERT_PASSWORD }}
```

### Signtool Verification
```powershell
# Verify signature
signtool verify /pa /v "NOC-AI-Assistant-Setup-1.0.0.exe"

# Timestamp verification
signtool verify /pa /v /tr http://timestamp.digicert.com "NOC-AI-Assistant-Setup-1.0.0.exe"
```

## Troubleshooting Build Issues

### PyInstaller Errors
| Error | Fix |
|-------|-----|
| `ModuleNotFoundError` | Add to `hidden-imports` in spec |
| `DLL load failed` | Add to `binaries` or `datas` in spec |
| `Permission denied` | Run as Administrator |
| `File too large` | Use `--upx-dir` or disable UPX |

### Electron Builder Errors
| Error | Fix |
|-------|-----|
| `Code signing failed` | Check certificate, password |
| `NSIS error` | Check installer.nsh syntax |
| `File not found` | Verify `extraResources` paths |
| `asar integrity` | Run `npm run build` first |

### Frontend Build Errors
| Error | Fix |
|-------|-----|
| `TypeScript errors` | Run `npm run typecheck` |
| `Tailwind not working` | Check `content` paths in tailwind.config.js |
| `Module not found` | Check `base: './'` in vite.config.ts |

## Build Performance

### Parallel Builds
```powershell
# Build backend and frontend simultaneously
Start-Job { cd backend; .\.venv\Scripts\pyinstaller.exe nocai-backend.spec }
Start-Job { cd apps\desktop\renderer; npm run build }
Wait-Job *
```

### Incremental Builds
- Frontend: `npm run build` uses Vite cache
- Backend: PyInstaller caches bytecode
- Electron: electron-builder caches node_modules

### Clean Build
```powershell
# Full clean
Remove-Item "apps/desktop/renderer/node_modules" -Recurse -Force
Remove-Item "apps/desktop/renderer/dist" -Recurse -Force
Remove-Item "backend/.venv" -Recurse -Force
Remove-Item "backend/dist" -Recurse -Force
Remove-Item "backend/build" -Recurse -Force
Remove-Item "apps/desktop/electron/dist" -Recurse -Force
Remove-Item "apps/desktop/electron/node_modules" -Recurse -Force
```

## Version Management

### Version Format
- Semantic Versioning: `MAJOR.MINOR.PATCH`
- Example: `1.0.0`, `1.1.0`, `1.1.1`

### Updating Version
```powershell
# Update all package.json files
$version = "1.0.2"

# Root (if exists)
# Apps/desktop/renderer/package.json
# Apps/desktop/electron/package.json
# Backend/pyproject.toml
```

### Release Checklist
- [ ] Version bumped in all locations
- [ ] Changelog updated
- [ ] All tests pass
- [ ] Clean build completed
- [ ] Checksums generated
- [ ] Installer tested on clean VM
- [ ] Portable tested
- [ ] Code signed (production)
- [ ] Release notes written
- [ ] GitHub release created
