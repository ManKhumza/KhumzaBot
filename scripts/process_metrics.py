"""Only process metadata for the explicitly supplied test-owned process tree."""
import json
import sys
import psutil


def snapshot(pid):
    try:
        parent = psutil.Process(pid)
        members = [parent, *parent.children(recursive=True)]
    except psutil.NoSuchProcess:
        return []
    result = []
    for process in members:
        try:
            result.append({
                "pid": process.pid,
                "started": process.create_time(),
                "name": process.name(),
                "rss": process.memory_info().rss,
                "threads": process.num_threads(),
                "handles": process.num_handles() if sys.platform == "win32" else process.num_fds(),
            })
        except psutil.NoSuchProcess:
            continue
    return result


if __name__ == "__main__":
    print(json.dumps(snapshot(int(sys.argv[1]))))
