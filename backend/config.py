import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional
from functools import lru_cache

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NOC_AI_", extra="ignore")
    # App
    app_name: str = "NOC AI Assistant"
    version: str = "1.0.2"
    debug: bool = False
    
    # Data directories
    data_dir: str = str(Path.home() / "AppData" / "Roaming" / "NOC AI Assistant")
    models_dir: str = str(Path.home() / "AppData" / "Roaming" / "NOC AI Assistant" / "models")
    knowledge_dir: str = str(Path.home() / "AppData" / "Roaming" / "NOC AI Assistant" / "knowledge")
    logs_dir: str = str(Path.home() / "AppData" / "Local" / "NOC AI Assistant" / "logs")
    
    # Database
    database_url: str = ""
    
    # Backend
    backend_host: str = "127.0.0.1"
    backend_port: int = 0
    session_token: str = ""
    
    # Inference
    llama_server_path: str = "llama-server"
    default_chat_model_id: Optional[str] = None
    default_embedding_model_id: Optional[str] = None
    default_context_length: int = 4096
    default_threads: int = 0
    default_gpu_layers: int = -1
    max_concurrent_generations: int = 1
    
    # Knowledge
    default_chunk_size: int = 384
    default_chunk_overlap: int = 50
    default_top_k: int = 10
    hybrid_alpha: float = 0.5
    enable_reranking: bool = False
    reranker_model_id: Optional[str] = None
    max_document_size_mb: int = 512
    ingestion_embedding_batch_size: int = 16
    
    # Security
    encryption_enabled: bool = True
    key_file_name: str = ".nocai.key"
    session_timeout_minutes: int = 480
    max_failed_logins: int = 5
    lockout_duration_minutes: int = 15
    password_min_length: int = 12
    require_special_chars: bool = True

    # Local inference process port allocation
    inference_port_start: int = 8100
    inference_port_end: int = 8200
    
    # Logging
    log_level: str = "INFO"
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if not self.database_url:
            self.database_url = f"sqlite:///{Path(self.data_dir) / 'nocai.db'}"
    
    def ensure_directories(self):
        """Ensure all required directories exist."""
        for dir_path in [self.data_dir, self.models_dir, self.knowledge_dir, self.logs_dir]:
            Path(dir_path).mkdir(parents=True, exist_ok=True)

@lru_cache()
def get_settings() -> Settings:
    """Get settings instance (cached). Settings are loaded from environment variables."""
    return Settings()
