# llama.cpp Binaries

This directory contains the llama.cpp runtime binaries required for model inference.

## Required Binaries

| Binary | Purpose |
|--------|---------|
| `llama-server.exe` | HTTP server for chat completions and embeddings |
| `llama-cli.exe` | Command-line interface for generation |
| `llama-embedding.exe` | Embedding-only CLI (if separate) |

## Required DLLs

| DLL | Purpose |
|-----|---------|
| `ggml.dll` | Core GGML library |
| `ggml-base.dll` | Base GGML operations |
| `ggml-cpu.dll` | CPU backend |
| `ggml-cuda.dll` | CUDA backend (if GPU support) |
| `ggml-vulkan.dll` | Vulkan backend (if GPU support) |
| `gguf.dll` | GGUF file format support |

## Building from Source (Recommended)

For production use, build llama.cpp from source with the features you need:

### Windows (Visual Studio)

```cmd
# Install dependencies
# - Visual Studio 2022 with C++ workload
# - CMake 3.22+
# - Git
# - CUDA Toolkit (optional, for GPU)
# - Vulkan SDK (optional, for GPU)

# Clone repository
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp

# Configure with desired backends
cmake -B build ^
  -DGGML_CUDA=ON ^
  -DGGML_VULKAN=ON ^
  -DGGML_OPENCL=ON ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_C_COMPILER=cl ^
  -DCMAKE_CXX_COMPILER=cl

# Build
cmake --build build --config Release --target llama-server llama-cli

# Copy binaries
copy build\bin\Release\llama-server.exe ..\runtimes\llama\
copy build\bin\Release\llama-cli.exe ..\runtimes\llama\
copy build\bin\Release\*.dll ..\runtimes\llama\
```

### With Metal (macOS)

```bash
cmake -B build \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release --target llama-server llama-cli
```

### Linux

```bash
# Ubuntu/Debian
apt-get update && apt-get install -y build-essential cmake libcurl4-openssl-dev
# For CUDA: apt-get install -y nvidia-cuda-toolkit

cmake -B build \
  -DGGML_CUDA=ON \
  -DGGML_VULKAN=ON \
  -DGGML_OPENCL=ON \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release --target llama-server llama-cli
```

## GGUF Model Format

Only GGUF format models are supported. The application validates GGUF files on import and extracts metadata including:

- Architecture (llama, qwen, mistral, etc.)
- Quantization (Q4_K_M, Q8_0, etc.)
- Parameter count (7B, 13B, 70B, etc.)
- Context length
- Embedding dimension (for embedding models)

## Hardware Compatibility

The application estimates memory requirements based on:
- Model file size
- Quantization level
- Context length
- Available system RAM/VRAM

Compatibility ratings:
- **RECOMMENDED** - Fits comfortably (< 50% available RAM)
- **COMPATIBLE** - Fits with margin (50-75% available RAM)
- **LIMITED** - Tight fit (75-100% available RAM)
- **NOT_RECOMMENDED** - May cause swapping (100-150% available RAM)
- **UNSUPPORTED** - Exceeds available memory (> 150%)

## GPU Offload

When a compatible GPU is detected:
- NVIDIA: CUDA backend (requires CUDA-enabled build)
- AMD: ROCm/HIP backend
- Intel/AMD/NVIDIA: Vulkan backend (cross-platform)
- Apple Silicon: Metal backend

The application automatically detects GPU capabilities and recommends optimal `ngl` (GPU layers) settings.

## Downloading Pre-built Binaries

For development, you can download pre-built binaries from:
- https://github.com/ggerganov/llama.cpp/releases

However, **pre-built binaries may not include all backends** (CUDA, Vulkan, Metal). For production, always build from source with your required features.

## Version Compatibility

This application is tested with llama.cpp versions from `b4401` (2024) onwards. The API is stable but may evolve. Pin to a specific commit for reproducible builds.