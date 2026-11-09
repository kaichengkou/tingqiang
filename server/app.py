"""Optional local audio service. The static frontend works without this service.

Run: python -m uvicorn server.app:app --host 127.0.0.1 --port 8000
Audio stays in .runtime/, is never committed, and expires after one hour.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("TINGQIANG_DATA_DIR", str(ROOT / ".runtime")))
MAX_BYTES = 100 * 1024 * 1024
MAX_DURATION = 20 * 60
TTL = 60 * 60
DEVICE = os.environ.get("TINGQIANG_DEVICE", "cpu")
ALLOWED_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get("TINGQIANG_ALLOWED_ORIGINS", "").split(",") if o.strip()}
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tingqiang")
LOCK = threading.RLock()


@dataclass
class Job:
    id: str
    directory: Path
    status: str = "queued"
    message: str = "已排队，等待音源分离。"
    updated: float = field(default_factory=time.time)
    cancelled: threading.Event = field(default_factory=threading.Event)
    process: subprocess.Popen | None = None

    def set(self, status: str, message: str) -> None:
        with LOCK:
            if not self.cancelled.is_set():
                self.status, self.message, self.updated = status, message, time.time()


JOBS: dict[str, Job] = {}


def separator_available() -> bool:
    return all(importlib.util.find_spec(module) is not None for module in ("demucs", "torch", "torchaudio", "soundfile")) and bool(shutil.which("ffmpeg")) and bool(shutil.which("ffprobe"))


def get_job(job_id: str) -> Job:
    if not re.fullmatch(r"[a-f0-9]{32}", job_id) or job_id not in JOBS:
        raise HTTPException(404, "任务不存在或已经过期。")
    return JOBS[job_id]


def terminate(process: subprocess.Popen, force: bool = False) -> None:
    """Stop a command and anything it started; Windows has no process groups to signal."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, timeout=30, check=True)
        except (OSError, subprocess.SubprocessError):
            process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass


def stop_job(job: Job) -> None:
    with LOCK:
        job.cancelled.set()
        job.status, job.message, job.updated = "cancelled", "分离已取消。", time.time()
        proc = job.process
    if proc:
        terminate(proc)


def run_command(job: Job, command: list[str], timeout: int = 1800) -> None:
    env = os.environ.copy()
    env.setdefault("OMP_NUM_THREADS", "4")
    env.setdefault("MKL_NUM_THREADS", "4")
    with (job.directory / "process.log").open("ab") as log:
        with LOCK:
            if job.cancelled.is_set():
                raise InterruptedError
            process = subprocess.Popen(command, stdout=log, stderr=log, env=env, start_new_session=True)
            job.process = process
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            terminate(process, force=True)
            process.wait()
            raise RuntimeError("处理超时，请缩短录音后重试。") from None
        finally:
            with LOCK:
                job.process = None
        if job.cancelled.is_set():
            raise InterruptedError
        if code:
            # Only a short local diagnostic is returned; no environment is dumped.
            detail = (job.directory / "process.log").read_text(errors="replace").strip().splitlines()
            raise RuntimeError("音频处理失败：" + (detail[-1][-350:] if detail else "请查看本地服务日志。"))


def process_job(job: Job) -> None:
    try:
        if job.cancelled.is_set():
            return
        job.set("running", "正在检查并解码录音…")
        try:
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(job.directory / "input")], capture_output=True, text=True, timeout=30, check=True)
            duration = float(json.loads(probe.stdout)["format"]["duration"])
        except (subprocess.SubprocessError, ValueError, KeyError):
            raise RuntimeError("文件不是可解码的音频。") from None
        if not 0.2 <= duration <= MAX_DURATION:
            raise RuntimeError("增强服务支持 0.2 秒到 20 分钟的录音，请截取一段后重试。")
        run_command(job, ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(job.directory / "input"), "-vn", "-t", str(MAX_DURATION), "-ac", "2", "-ar", "44100", str(job.directory / "recording.wav")], timeout=120)
        job.set("running", "正在分离人声与伴奏；首次使用会下载开源模型，CPU 处理需要一些时间。")
        run_command(job, [sys.executable, "-m", "demucs", "--two-stems", "vocals", "--name", "htdemucs", "--device", DEVICE, "--shifts", "0", "--jobs", "0", "--clip-mode", "clamp", "--out", str(job.directory / "separated"), str(job.directory / "recording.wav")])
        output = job.directory / "separated" / "htdemucs" / "recording"
        for source, target in (("vocals.wav", "vocals.wav"), ("no_vocals.wav", "accompaniment.wav")):
            file = output / source
            if not file.is_file():
                raise RuntimeError("模型没有返回完整分轨，请重试。")
            shutil.move(file, job.directory / target)
        shutil.rmtree(job.directory / "separated", ignore_errors=True)
        (job.directory / "recording.wav").unlink(missing_ok=True)
        (job.directory / "input").unlink(missing_ok=True)
        job.set("done", "人声与伴奏已分离完成。")
    except InterruptedError:
        pass
    except Exception as error:
        job.set("failed", str(error)[:1100])
    finally:
        if job.cancelled.is_set():
            shutil.rmtree(job.directory, ignore_errors=True)


async def clean_expired() -> None:
    while True:
        await asyncio.sleep(60)
        with LOCK:
            expired = [key for key, job in JOBS.items() if job.status in {"done", "failed", "cancelled"} and time.time() - job.updated > TTL]
            for key in expired:
                shutil.rmtree(JOBS.pop(key).directory, ignore_errors=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    DATA.mkdir(parents=True, exist_ok=True)
    # Crash leftovers are not exposed by the API; remove only old job directories.
    for directory in DATA.iterdir():
        if directory.is_dir() and re.fullmatch(r"[a-f0-9]{32}", directory.name) and time.time() - directory.stat().st_mtime > TTL:
            shutil.rmtree(directory, ignore_errors=True)
    cleaner = asyncio.create_task(clean_expired())
    yield
    cleaner.cancel()
    for job in list(JOBS.values()):
        if job.status in {"running", "queued"}:
            stop_job(job)


app = FastAPI(title="听腔增强服务", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=sorted(ALLOWED_ORIGINS), allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"], allow_credentials=False)


@app.middleware("http")
async def check_origin(request: Request, call_next):
    origin = request.headers.get("origin", "").rstrip("/")
    own_origin = str(request.base_url).rstrip("/")
    if origin and origin != own_origin and origin not in ALLOWED_ORIGINS:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "未允许该网页来源，请配置 TINGQIANG_ALLOWED_ORIGINS。"}, status_code=403)
    response = await call_next(request)
    # Revalidate every file, so an update never mixes old and new modules.
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.get("/api/health")
def health():
    return {"app": "tingqiang", "version": "0.8.0", "demucs_available": separator_available(), "max_upload_mb": 100, "device": DEVICE}


@app.post("/api/jobs", status_code=202)
async def create_job(file: UploadFile = File(...)):
    if not separator_available():
        raise HTTPException(503, "分离依赖未安装，请按 README 安装 Demucs、PyTorch 和 FFmpeg。")
    with LOCK:
        if sum(job.status in {"queued", "running"} for job in JOBS.values()) >= 2:
            raise HTTPException(429, "分离服务正在处理其他录音，请稍后重试。")
        job_id = uuid.uuid4().hex
        job = Job(job_id, DATA / job_id)
        JOBS[job_id] = job
    job.directory.mkdir(parents=True, exist_ok=True)
    count = 0
    try:
        with (job.directory / "input").open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                count += len(chunk)
                if count > MAX_BYTES:
                    raise HTTPException(413, "增强服务支持最大 100 MB 的录音。")
                output.write(chunk)
        if count == 0:
            raise HTTPException(400, "录音文件为空。")
    except Exception:
        with LOCK:
            JOBS.pop(job_id, None)
        shutil.rmtree(job.directory, ignore_errors=True)
        raise
    finally:
        await file.close()
    POOL.submit(process_job, job)
    return {"id": job_id, "status": "queued"}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with LOCK:
        job = get_job(job_id)
        return {"id": job.id, "status": job.status, "message": job.message}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = get_job(job_id)
    stop_job(job)
    if job.process is None:
        shutil.rmtree(job.directory, ignore_errors=True)
    return {"id": job.id, "status": "cancelled"}


@app.get("/api/jobs/{job_id}/{stem}.wav")
def get_stem(job_id: str, stem: str):
    if stem not in {"vocals", "accompaniment"}:
        raise HTTPException(404, "分轨不存在。")
    with LOCK:
        job = get_job(job_id)
        if job.status != "done":
            raise HTTPException(409, "分离尚未完成。")
        job.updated = time.time()
    return FileResponse(job.directory / f"{stem}.wav", media_type="audio/wav", headers={"Cache-Control": "no-store"})


app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
