import psutil
import platform
import subprocess
import json
import logging
from dataclasses import dataclass
from typing import Optional, List

logger = logging.getLogger(__name__)

@dataclass
class GPUInfo:
    name: str
    vendor: str
    vram_total_mb: int
    vram_free_mb: int
    driver_version: str
    cuda_version: Optional[str] = None
    vulkan_version: Optional[str] = None

@dataclass
class HardwareInfo:
    os_name: str
    os_version: str
    cpu_name: str
    cpu_cores_logical: int
    cpu_cores_physical: int
    cpu_freq_max_mhz: float
    cpu_architecture: str
    total_memory_mb: int
    available_memory_mb: int
    gpus: List[GPUInfo]
    data_disk_free_gb: float
    data_disk_total_gb: float
    llama_cpp_version: str
    supports_cuda: bool
    supports_vulkan: bool
    supports_metal: bool
    supports_opencl: bool
    supports_rocm: bool

@dataclass
class ResourceEstimate:
    model_size_mb: float
    estimated_ram_mb: float
    estimated_vram_mb: float
    kv_cache_mb_per_1k_tokens: float
    compatibility: str
    warnings: List[str]
    reasons: List[str]

async def detect_hardware() -> HardwareInfo:
    os_name = platform.system()
    os_version = platform.version()
    cpu_name = platform.processor()
    cpu_cores_logical = psutil.cpu_count(logical=True)
    cpu_cores_physical = psutil.cpu_count(logical=False)
    cpu_freq = psutil.cpu_freq()
    cpu_freq_max_mhz = cpu_freq.max if cpu_freq else 0
    cpu_architecture = platform.machine()
    
    mem = psutil.virtual_memory()
    total_memory_mb = mem.total // (1024 * 1024)
    available_memory_mb = mem.available // (1024 * 1024)
    
    gpus = await detect_gpus()
    
    disk = psutil.disk_usage("/")
    data_disk_free_gb = disk.free / (1024**3)
    data_disk_total_gb = disk.total / (1024**3)
    
    llama_info = await detect_llama_cpp_capabilities()
    
    return HardwareInfo(
        os_name=os_name,
        os_version=os_version,
        cpu_name=cpu_name,
        cpu_cores_logical=cpu_cores_logical,
        cpu_cores_physical=cpu_cores_physical,
        cpu_freq_max_mhz=cpu_freq_max_mhz,
        cpu_architecture=cpu_architecture,
        total_memory_mb=total_memory_mb,
        available_memory_mb=available_memory_mb,
        gpus=gpus,
        data_disk_free_gb=data_disk_free_gb,
        data_disk_total_gb=data_disk_total_gb,
        **llama_info
    )

async def detect_gpus() -> List[GPUInfo]:
    gpus = []
    
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version", 
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            for line in result.stdout.strip().split('\n'):
                name, total, free, driver = line.split(', ')
                gpus.append(GPUInfo(
                    name=name.strip(),
                    vendor="NVIDIA",
                    vram_total_mb=int(total.strip()),
                    vram_free_mb=int(free.strip()),
                    driver_version=driver.strip(),
                    cuda_version=await get_cuda_version(),
                ))
    except:
        pass
    
    try:
        result = subprocess.run(
            ["rocm-smi", "--showproductname", "--showvram", "--showdriverversion", "--json"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            for gpu_id, info in data.items():
                gpus.append(GPUInfo(
                    name=info.get("Card series", "AMD GPU"),
                    vendor="AMD",
                    vram_total_mb=int(info.get("VRAM Total Memory (B)", 0)) // (1024*1024),
                    vram_free_mb=int(info.get("VRAM Free Memory (B)", 0)) // (1024*1024),
                    driver_version=info.get("Driver Version", "unknown"),
                ))
    except:
        pass
    
    return gpus

async def get_cuda_version() -> Optional[str]:
    try:
        result = subprocess.run(["nvcc", "--version"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.split('\n'):
            if 'release' in line:
                return line.split('release')[-1].split(',')[0].strip()
    except:
        pass
    return None

async def detect_llama_cpp_capabilities() -> dict:
    try:
        result = subprocess.run(
            ["llama-server", "--help"],
            capture_output=True, text=True, timeout=10
        )
        help_text = result.stdout
        
        return {
            "llama_cpp_version": extract_version(help_text),
            "supports_cuda": "CUDA" in help_text or "ggml-cuda" in help_text,
            "supports_vulkan": "Vulkan" in help_text or "ggml-vulkan" in help_text,
            "supports_metal": "Metal" in help_text or "ggml-metal" in help_text,
            "supports_opencl": "OpenCL" in help_text or "ggml-opencl" in help_text,
            "supports_rocm": "HIP" in help_text or "ggml-hip" in help_text,
        }
    except:
        return {
            "llama_cpp_version": "unknown",
            "supports_cuda": False,
            "supports_vulkan": False,
            "supports_metal": False,
            "supports_opencl": False,
            "supports_rocm": False,
        }

def extract_version(text: str) -> str:
    for line in text.split('\n'):
        if 'version' in line.lower():
            return line.strip()
    return "unknown"

def estimate_model_requirements(
    model_path: str, 
    hardware: HardwareInfo,
    context_length: int = 4096
) -> ResourceEstimate:
    try:
        import gguf
        from pathlib import Path
        
        reader = gguf.GGUFReader(model_path)
        metadata = dict(reader.get_all_metadata())
        
        arch = metadata.get('general.architecture', ['unknown'])[0]
        n_params = metadata.get('general.parameter_count', [0])[0]
        n_layers = metadata.get(f'{arch}.block_count', [0])[0]
        embed_dim = metadata.get(f'{arch}.embedding_length', [0])[0]
        
        file_size_mb = Path(model_path).stat().st_size / (1024 * 1024)
        
        weight_memory_mb = file_size_mb * 1.15
        
        kv_per_token_mb = (2 * n_layers * embed_dim * 2) / (1024 * 1024)
        kv_memory_mb = kv_per_token_mb * context_length
        
        activation_mb = (n_layers * embed_dim * 4 * context_length) / (1024 * 1024) * 0.1
        
        total_ram_mb = weight_memory_mb + kv_memory_mb + activation_mb + 1024
        
        gpu_offload_possible = any(
            g.vram_free_mb > weight_memory_mb * 1.2 for g in hardware.gpus
        )
        estimated_vram_mb = weight_memory_mb * 1.2 if gpu_offload_possible else 0
        
        available_ram = hardware.available_memory_mb
        ram_ratio = total_ram_mb / available_ram if available_ram > 0 else float('inf')
        
        if ram_ratio < 0.5:
            compatibility = "RECOMMENDED"
        elif ram_ratio < 0.75:
            compatibility = "COMPATIBLE"
        elif ram_ratio < 1.0:
            compatibility = "LIMITED"
        elif ram_ratio < 1.5:
            compatibility = "NOT_RECOMMENDED"
        else:
            compatibility = "UNSUPPORTED"
        
        warnings = []
        reasons = []
        
        if ram_ratio > 0.9:
            warnings.append(f"Model requires ~{total_ram_mb:.0f}MB RAM, only {available_ram}MB available")
        if not gpu_offload_possible and hardware.gpus:
            warnings.append("No GPU with sufficient VRAM for full offload")
        if not hardware.gpus:
            reasons.append("Running on CPU only - inference will be slower")
        else:
            reasons.append(f"GPU available: {', '.join(g.name for g in hardware.gpus)}")
        
        return ResourceEstimate(
            model_size_mb=file_size_mb,
            estimated_ram_mb=total_ram_mb,
            estimated_vram_mb=estimated_vram_mb,
            kv_cache_mb_per_1k_tokens=kv_per_token_mb * 1000,
            compatibility=compatibility,
            warnings=warnings,
            reasons=reasons,
        )
    except Exception as e:
        logger.error(f"Failed to estimate model requirements: {e}")
        return ResourceEstimate(
            model_size_mb=0,
            estimated_ram_mb=0,
            estimated_vram_mb=0,
            kv_cache_mb_per_1k_tokens=0,
            compatibility="UNKNOWN",
            warnings=[str(e)],
            reasons=[],
        )