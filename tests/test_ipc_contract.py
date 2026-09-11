"""Tests for IPC contract between preload, Electron main, and backend."""

from pathlib import Path


def test_ipc_preload_chat_stop_generation():
    """IPC contract: preload.ts nocai:chat:stopGeneration has matching Electron handler."""
    preload_path = Path(__file__).parents[1] / "apps" / "desktop" / "preload" / "preload.ts"
    main_path = Path(__file__).parents[1] / "apps" / "desktop" / "electron" / "main.ts"
    
    if not preload_path.exists() or not main_path.exists():
        # Skip if files don't exist in test environment
        return
    
    preload_content = preload_path.read_text()
    main_content = main_path.read_text()
    
    # Check preload invokes nocai:chat:stopGeneration
    assert "nocai:chat:stopGeneration" in preload_content
    
    # Check Electron main has handler for stopGeneration
    assert "stopGeneration" in main_content or "chat:stop" in main_content


def test_ipc_first_run_status_contract():
    """Onboarding contract: the renderer can distinguish setup from sign-in."""
    root = Path(__file__).parents[1]
    preload_content = (root / "apps" / "desktop" / "preload" / "preload.ts").read_text()
    main_content = (root / "apps" / "desktop" / "electron" / "main.ts").read_text()
    login_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Login.tsx").read_text()

    assert "getStatus: () => ipcRenderer.invoke('nocai:auth:getStatus')" in preload_content
    assert "ipcMain.handle('nocai:auth:getStatus'" in main_content
    assert "nocaiAPI.auth.getStatus()" in login_content
    assert "confirmPassword" in login_content


def test_ipc_preload_rename_conversation_signature():
    """IPC contract: preload renameConversation matches Electron handler signature."""
    preload_path = Path(__file__).parents[1] / "apps" / "desktop" / "preload" / "preload.ts"
    main_path = Path(__file__).parents[1] / "apps" / "desktop" / "electron" / "main.ts"
    
    if not preload_path.exists() or not main_path.exists():
        return
    
    preload_content = preload_path.read_text()
    main_content = main_path.read_text()
    
    assert "ipcRenderer.invoke('nocai:chat:renameConversation', { id, title })" in preload_content
    assert "ipcMain.handle('nocai:chat:renameConversation', async (event, { id, title })" in main_content


def test_ipc_conversation_preferences_update_contract():
    """IPC contract: chat preferences cross preload and Electron as one typed payload."""
    root = Path(__file__).parents[1]
    preload_content = (root / "apps" / "desktop" / "preload" / "preload.ts").read_text()
    main_content = (root / "apps" / "desktop" / "electron" / "main.ts").read_text()
    renderer_types = (root / "apps" / "desktop" / "renderer" / "src" / "utils" / "api.ts").read_text()

    assert "updateConversation: (id: string, updates: ConversationUpdate)" in renderer_types
    assert "ipcRenderer.invoke('nocai:chat:updateConversation', { id, updates })" in preload_content
    assert "ipcMain.handle('nocai:chat:updateConversation', async (event, { id, updates })" in main_content
    assert "body: JSON.stringify(updates)" in main_content


def test_ipc_backend_patch_conversation_title_body():
    """IPC contract: Electron sends PATCH /api/v1/chat/conversations/{id} with {title} in body."""
    routes_path = Path(__file__).parents[1] / "backend" / "chat" / "routes.py"
    routes_content = routes_path.read_text()

    assert "request: UpdateConversationRequest" in routes_content
    assert "conversation.title = request.title" in routes_content


def test_ipc_backend_reprocess_document_route():
    """IPC contract: Electron calls /api/v1/knowledge/documents/{id}/reprocess."""
    root = Path(__file__).parents[1]
    main_content = (root / "apps" / "desktop" / "electron" / "main.ts").read_text()
    routes_content = (root / "backend" / "knowledge" / "routes.py").read_text()

    assert "/api/v1/knowledge/documents/${id}/reprocess" in main_content
    assert '@router.post("/documents/{document_id}/reprocess")' in routes_content


def test_ipc_system_get_version():
    """IPC contract: nocai:system:getVersion returns string version, not health JSON."""
    root = Path(__file__).parents[1]
    main_content = (root / "apps" / "desktop" / "electron" / "main.ts").read_text()

    assert "ipcMain.handle('nocai:system:getVersion'" in main_content
    assert "return app.getVersion()" in main_content


def test_ipc_error_banner_does_not_restart_backend():
    """IPC contract: error banner close dismisses banner, doesn't restart backend."""
    banner_path = Path(__file__).parents[1] / "apps" / "desktop" / "renderer" / "src" / "components" / "common" / "BackendStatusBanner.tsx"
    banner_content = banner_path.read_text()

    assert "onClick={() => setDismissed(true)}" in banner_content
    assert "restartBackend" not in banner_content


def test_renderer_operator_health_and_storage_contracts():
    """Renderer health: operators use public readiness and percentages are not scaled twice."""
    root = Path(__file__).parents[1]
    layout_content = (root / "apps" / "desktop" / "renderer" / "src" / "components" / "layout" / "Layout.tsx").read_text()
    home_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Home.tsx").read_text()

    assert "nocaiAPI.system.getHealth()" in layout_content
    assert "nocaiAPI.admin.getHealth()" not in layout_content
    assert "health.storage.usagePercent.toFixed(1)" in home_content
    assert "storage.usagePercent || 0) * 100" not in home_content


def test_renderer_enforces_required_password_change():
    """Onboarding and authentication: required password changes gate normal routes."""
    root = Path(__file__).parents[1]
    app_content = (root / "apps" / "desktop" / "renderer" / "src" / "App.tsx").read_text()
    settings_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Settings.tsx").read_text()
    store_content = (root / "apps" / "desktop" / "renderer" / "src" / "stores" / "authStore.tsx").read_text()

    assert "user?.mustChangePassword && location.pathname !== '/settings'" in app_content
    assert "passwordChangeRequired" in settings_content
    assert "mustChangePassword: false" in store_content
    assert "isLoading: true" in store_content
    assert "zustand/middleware" not in store_content


def test_dev_renderer_respects_electron_csp():
    """Renderer development: Vite does not inject the CSP-blocked refresh preamble."""
    vite_config = Path(__file__).parents[1] / "apps" / "desktop" / "renderer" / "vite.config.ts"
    assert "hmr: false" in vite_config.read_text()


def test_electron_dev_backend_resolves_repository_root():
    """Desktop smoke: compiled Electron resolves the root-level Python environment."""
    main_path = Path(__file__).parents[1] / "apps" / "desktop" / "electron" / "main.ts"
    main_content = main_path.read_text()

    assert "join(__dirname, '../../../../..')" in main_content
    assert "join(projectRoot, '.venv', 'Scripts', 'python.exe')" in main_content


def test_electron_allows_first_run_model_initialization():
    """Desktop smoke: first-run model setup gets a realistic startup window."""
    main_path = Path(__file__).parents[1] / "apps" / "desktop" / "electron" / "main.ts"
    main_content = main_path.read_text()

    assert "await waitForPort(backendPort!, 60000, signal)" in main_content
    assert "Backend exited before opening its local port" in main_content


def test_electron_ipc_waits_for_backend_startup():
    """Desktop startup: renderer API calls wait for backend readiness instead of racing it."""
    main_path = Path(__file__).parents[1] / "apps" / "desktop" / "electron" / "main.ts"
    main_content = main_path.read_text()

    assert "if (backendStartupPromise) await backendStartupPromise" in main_content
    assert "backendStartupPromise = startupPromise" in main_content
    assert "await nativeFetch(`http://127.0.0.1:${backendPort}/health/ready`" in main_content
    assert "if (!sessionToken) return null" in main_content


def test_missing_preload_bridge_cannot_deadlock_authentication():
    """Renderer startup fails visibly when the preload bridge is unavailable."""
    api_path = Path(__file__).parents[1] / "apps" / "desktop" / "renderer" / "src" / "utils" / "api.ts"
    api_content = api_path.read_text(encoding="utf-8")

    assert "if (!window.nocai)" in api_content
    assert "Desktop integration failed to load" in api_content
    assert "window.addEventListener('nocai:ready'" not in api_content


def test_renderer_treats_backend_timestamps_as_utc():
    """Renderer contract: timezone-free backend timestamps are normalized as UTC."""
    root = Path(__file__).parents[1]
    date_content = (root / "apps" / "desktop" / "renderer" / "src" / "utils" / "date.ts").read_text()
    chats_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Chats.tsx").read_text()
    home_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Home.tsx").read_text()

    assert "TIME_ZONE_SUFFIX.test(value) ? value : `${value}Z`" in date_content
    assert "import { relativeTime } from '@/utils/date'" in chats_content
    assert "import { relativeTime } from '@/utils/date'" in home_content


def test_large_document_picker_and_upload_contract():
    """Knowledge uploads pass native paths instead of copying browser File objects."""
    root = Path(__file__).parents[1]
    main_content = (root / "apps" / "desktop" / "electron" / "main.ts").read_text()
    preload_content = (root / "apps" / "desktop" / "preload" / "preload.ts").read_text()
    knowledge_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Knowledge.tsx").read_text()

    assert "nocai:knowledge:selectDocuments" in main_content
    assert "JSON.stringify({ filePaths })" in main_content
    assert "selectDocuments: () => ipcRenderer.invoke('nocai:knowledge:selectDocuments')" in preload_content
    assert "uploadFiles.map((file) => file.path)" in knowledge_content


def test_renderer_exposes_readable_chat_selectors_behavior_and_source_deletion():
    """Renderer UX: chat controls are readable and admin knowledge controls are reachable."""
    root = Path(__file__).parents[1]
    chat_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "ChatView.tsx").read_text()
    settings_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Settings.tsx").read_text()
    knowledge_content = (root / "apps" / "desktop" / "renderer" / "src" / "pages" / "Knowledge.tsx").read_text()

    assert "w-[min(30rem,calc(100vw-2rem))]" in chat_content
    assert "max-h-[min(70vh,32rem)]" in chat_content
    assert "All knowledge sources" in chat_content
    assert "label: 'Behavior'" in settings_content
    assert "Where answers may come from" in settings_content
    assert "Citation format" in settings_content
    assert "Delete Source" in knowledge_content
    assert "setShowDeleteCollectionConfirm(true)" in knowledge_content


def test_renderer_failure_is_contained_and_recoverable():
    """A route render failure has an in-app fallback and a process-level reload path."""
    root = Path(__file__).parents[1]
    main_content = (root / "apps" / "desktop" / "electron" / "main.ts").read_text()
    layout_content = (root / "apps" / "desktop" / "renderer" / "src" / "components" / "layout" / "Layout.tsx").read_text()
    boundary_content = (root / "apps" / "desktop" / "renderer" / "src" / "components" / "common" / "AppErrorBoundary.tsx").read_text()

    assert "render-process-gone" in main_content
    assert "window.reload()" in main_content
    assert "<AppErrorBoundary resetKey={location.pathname}" in layout_content
    assert "static getDerivedStateFromError" in boundary_content
