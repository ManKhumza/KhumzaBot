# NOC AI Assistant - User Guide

## Getting Started

### Installation
1. Download `NOC-AI-Assistant-Setup-<version>.exe`
2. Run the installer
3. Choose installation directory
4. Complete installation
5. Launch from Start Menu or Desktop shortcut

### First Launch
1. Application starts with a splash screen
2. Backend service starts automatically (may take 10-30 seconds)
3. Login screen appears

### Default Credentials
- **Username**: `admin`
- **Password**: `ChangeMe123!` (must be changed on first login)

## Main Interface

### Sidebar Navigation
- **Home** - Dashboard with system status and quick actions
- **Chats** - Conversation history and new chat
- **Models** - Manage local AI models
- **Knowledge** - Document collections and ingestion
- **Search** - Query knowledge base directly
- **Settings** - Application preferences
- **Administration** (admin only) - Users, audit, jobs, health

### Top Bar
- Active chat model indicator
- Active knowledge collection indicator
- Backend connection status
- Theme toggle (Light/Dark/System)

## Chatting

### Starting a Conversation
1. Click **New Chat** in sidebar or press `Ctrl+N`
2. Select a chat model (must be activated first)
3. Optionally select a knowledge collection for RAG
4. Type your message and press Enter

### Chat Features
- **Streaming responses** - Tokens appear in real-time
- **Stop generation** - Click Stop button to cancel
- **Copy messages** - Hover message and click copy icon
- **Code blocks** - Syntax highlighted with copy button
- **Citations** - Sources shown below assistant responses
- **Expand citations** - Click to view source preview

### Model-Only vs Knowledge Mode
- **No collection selected** - Pure LLM chat
- **Collection selected** - RAG mode with citations
- **Indicator** - Top bar shows "Knowledge: None" or collection name

## Managing Models

### Importing Models
1. Go to **Models** page
2. Click **Import Model** or **Scan Directory**
3. Select a `.gguf` file or directory
4. Choose role: **Chat Model** or **Embedding Model**
5. Click **Import**

### Model Requirements
- Only **GGUF format** supported
- Hardware compatibility checked automatically
- Status: RECOMMENDED / COMPATIBLE / LIMITED / NOT_RECOMMENDED / UNSUPPORTED

### Activating Models
- One chat model and one embedding model can be active
- Click **Activate** on model card
- Previous model for that role is deactivated
- Loading takes 5-30 seconds depending on model size

## Knowledge Base

### Creating Collections
1. Go to **Knowledge** page
2. Click **New Collection**
3. Name and describe the collection
4. Select embedding model
5. Configure chunking (default: 512 tokens, 50 overlap)
6. Create

### Uploading Documents
1. Select a collection
2. Click **Upload Documents**
3. Drag & drop or browse files
4. Supported: `.txt`, `.md`, `.pdf`, `.docx`, `.csv`, `.html`
5. Files are processed automatically

### Document Processing Stages
1. **Queued** → **Validating** → **Parsing** → **Chunking** → **Embedding** → **Indexing** → **Ready**
2. Failed documents show error message
3. Can retry failed documents

### Supported Formats
| Format | Parser | Notes |
|--------|--------|-------|
| `.pdf` | pypdf | Scanned PDFs need OCR (not included) |
| `.docx` | python-docx | Includes tables |
| `.txt` / `.md` | Native | Plain text and Markdown |
| `.csv` | csv | Converted to text rows |
| `.html` | BeautifulSoup | Strips scripts/styles |

## Searching Knowledge

### Direct Search
1. Go to **Search** page
2. Enter query
3. Select collections to search
4. Adjust parameters:
   - **Top K** - Number of results (5-50)
   - **Hybrid α** - Vector vs keyword balance (0-1)
   - **Reranking** - Use cross-encoder (requires model)
5. Click **Search**

### Results
- Ranked by relevance score
- Expand to see full chunk content
- Copy text directly
- Open source document preview

## Settings

### Appearance
- **Theme**: Light / Dark / System
- **Language**: English (more coming)
- **Sidebar**: Collapsed by default
- **Compact mode**: Reduced spacing

### Models
- Default chat/embedding model IDs
- Model directory location
- Default context length (4096)
- Threads (0 = auto)
- GPU layers (-1 = auto)

### Knowledge
- Default chunk size/overlap
- Top K results
- Hybrid search weight
- Reranking enable/model

### Storage
- Data, model, knowledge locations
- Usage statistics

### Security
- Session timeout (default 8 hours)
- Failed login lockout
- Password requirements

### Diagnostics
- Log level
- Debug mode
- Log location: `%LOCALAPPDATA%\NOC AI Assistant\logs\`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New Chat |
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Escape` | Stop generation / Close dialog |
| `Ctrl+/` | Focus search (in Search page) |

## Troubleshooting

### Backend Won't Start
1. Check `%LOCALAPPDATA%\NOC AI Assistant\logs\backend-*.log`
2. Ensure no other app uses the port
3. Restart application

### Model Won't Load
- Check available RAM vs model requirements
- Try smaller quantization (Q4_K_M vs Q8_0)
- Check llama.cpp compatibility

### Documents Not Processing
- Check file format is supported
- Verify file isn't corrupted
- Check logs for specific errors

### Out of Memory
- Close other applications
- Use smaller model
- Reduce context length
- Enable GPU offload if available

## Data Locations

| Data Type | Location |
|-----------|----------|
| Database | `%APPDATA%\NOC AI Assistant\data\nocai.db` |
| Models | `%APPDATA%\NOC AI Assistant\models\` |
| Knowledge | `%APPDATA%\NOC AI Assistant\knowledge\` |
| Logs | `%LOCALAPPDATA%\NOC AI Assistant\logs\` |
| Cache | `%LOCALAPPDATA%\NOC AI Assistant\Cache\` |

## Backup & Restore

### Creating Backup
1. Go to Settings → Diagnostics
2. Click **Create Backup**
3. Choose what to include:
   - Database (required)
   - Configuration
   - Models (optional, large)
   - Knowledge documents (optional)

### Restoring Backup
1. Go to Settings → Diagnostics
2. Click **Restore Backup**
3. Select backup file
4. Application restarts automatically

## Uninstallation

1. Windows Settings → Apps → NOC AI Assistant → Uninstall
2. Optionally remove user data (models, knowledge, chats)
3. Start Menu and Desktop shortcuts removed

## Support

- **Logs**: `%LOCALAPPDATA%\NOC AI Assistant\logs\`
- **Version**: Help → About
- **Diagnostics**: Settings → Diagnostics → Export Diagnostics