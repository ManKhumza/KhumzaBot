# NOC AI Assistant

NOC AI Assistant is a local Windows desktop application built with Electron, React, FastAPI, SQLite, and llama.cpp. User data, imported GGUF models, documents, and chat history remain on the local machine.

## Requirements

- Windows 10 or 11 x64
- Node.js 20 or newer
- Python 3.11 or newer
- PowerShell 7 is recommended

## Build an installer

From the repository root:

```powershell
.\scripts\build-all.ps1
```

The script installs reproducible dependencies, downloads the official llama.cpp CPU runtime and Python embedded runtime, runs the backend and TypeScript checks, and creates setup and portable executables in `apps\desktop\electron\release`.

The Windows package includes the 36.7 MB `bge-small-en-v1.5` Q8_0 GGUF embedding model. On first run it is checksum-verified, copied to the application data models directory, registered as an embedding model, and activated when no other embedding model is active.

### Signed Windows release

Install a publicly trusted Authenticode code-signing certificate and its vendor token/cloud-signing client. Find the certificate exposed by that client to the Windows certificate store:

```powershell
Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert |
    Select-Object Subject, Thumbprint, NotAfter, HasPrivateKey
```

Then build with that certificate's thumbprint:

```powershell
$env:NOC_AI_CERT_THUMBPRINT = "CERTIFICATE_THUMBPRINT"
.\scripts\build-all.ps1 -Sign
```

For a password-protected PFX supplied by an internal PKI, set `NOC_AI_CERT_PFX` and `NOC_AI_CERT_PASSWORD` in the current shell instead. Public code-signing CAs normally require non-exportable hardware or cloud key storage. Do not save certificate passwords in the repository or command-line arguments. The signed build signs all otherwise-unsigned EXE, DLL, and PYD files in the packaged application before signing the final installer and portable executable.

## First run

On a new installation, the first username and password entered become the local administrator account. The password must contain at least 12 characters. Import a GGUF chat model on the Models page, activate it, then create a conversation.

## Development checks

```powershell
.\.venv\Scripts\python.exe -m pytest tests
npm.cmd run typecheck --prefix apps/desktop/renderer
npm.cmd run build --prefix apps/desktop/renderer
npm.cmd run build --prefix apps/desktop/electron
```

## Supervised Nemotron development

The project includes an OpenCode agent profile, persistent engineering rules,
and an independent test/build feedback loop. See
[`docs/nemotron-harness.md`](docs/nemotron-harness.md), then run:

```powershell
.\scripts\nemotron-harness.ps1
```
