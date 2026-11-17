"""Background jobs: thread pool, progress, cancellation, SSE fan-out.

A job function receives a `Job` and returns a JSON-able result. It reports with
`job.update(progress, message)` and must call `job.check()` in loops (raises
`Cancelled`). Subprocesses started through `job.run(...)` / `job.popen(...)` are
killed when the job is cancelled.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import subprocess
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class Cancelled(Exception):
    pass


class JobError(Exception):
    """An expected failure with a user-readable message. `code` is a stable machine-readable reason for the app
    (e.g. "hf_auth_required", "network", "checksum"), `info` extra JSON fields (e.g. {"accept_url": ...})."""

    def __init__(self, message: str = "", code: str | None = None, info: dict | None = None):
        super().__init__(message)
        self.code = code
        self.info = info or {}


class Job:
    def __init__(self, mgr: "JobManager", kind: str, meta: dict | None = None):
        self.mgr = mgr
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.meta = meta or {}
        self.progress = 0.0
        self.message = "queued"
        self.state = "queued"
        self.result: Any = None
        self.error: str | None = None
        self.error_code: str | None = None
        self.error_info: dict = {}
        self.created = time.time()
        self._cancel = threading.Event()
        self._procs: list[subprocess.Popen] = []
        self._plock = threading.Lock()
        self._span = (0.0, 1.0)   # current step's slice of the overall progress
        self._outer = (0.0, 1.0)  # slice owned by the enclosing scope()

    # ---- reporting -------------------------------------------------------
    def update(self, progress: float | None = None, message: str | None = None):
        if progress is not None:
            a, b = self._span
            self.progress = round(a + (b - a) * min(max(progress, 0.0), 1.0), 4)
        if message is not None:
            self.message = message
        self.mgr.emit(self)

    def span(self, a: float, b: float):
        """Map following update(0..1) calls into [a, b] of the current scope."""
        o0, o1 = self._outer
        self._span = (o0 + (o1 - o0) * a, o0 + (o1 - o0) * b)
        self.update(0.0)

    @contextlib.contextmanager
    def scope(self, a: float, b: float):
        """Nest a whole step function (which calls span() itself) into [a, b] of the current scope."""
        saved = self._outer, self._span
        o0, o1 = self._outer
        self._outer = (o0 + (o1 - o0) * a, o0 + (o1 - o0) * b)
        self._span = self._outer
        try:
            yield self
        finally:
            self._outer, self._span = saved

    def check(self):
        if self._cancel.is_set():
            raise Cancelled()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def cancel(self):
        self._cancel.set()
        with self._plock:
            for p in self._procs:
                try:
                    p.kill()
                except Exception:
                    pass

    # ---- subprocesses ----------------------------------------------------
    def popen(self, args, **kw) -> subprocess.Popen:
        self.check()
        kw.setdefault("creationflags", CREATE_NO_WINDOW)
        try:
            p = subprocess.Popen([str(a) for a in args], **kw)
        except FileNotFoundError:
            raise JobError(f"{Path_name(args[0])} not found - finish first-run setup (Settings > Models, "
                           "POST /models/install)") from None
        with self._plock:
            self._procs.append(p)
        if self._cancel.is_set():
            p.kill()
        return p

    def release(self, p: subprocess.Popen):
        with self._plock:
            if p in self._procs:
                self._procs.remove(p)

    def run(self, args, check=True, capture=True, timeout=None, **kw) -> subprocess.CompletedProcess:
        if capture:
            kw.setdefault("stdout", subprocess.PIPE)
            kw.setdefault("stderr", subprocess.PIPE)
        p = self.popen(args, **kw)
        try:
            out, err = p.communicate(timeout=timeout)
        finally:
            self.release(p)
        self.check()
        cp = subprocess.CompletedProcess(p.args, p.returncode, out, err)
        if check and p.returncode != 0:
            tail = (err or b"")[-1500:]
            if isinstance(tail, bytes):
                tail = tail.decode("utf-8", "replace")
            raise JobError(f"{Path_name(args[0])} failed ({p.returncode}): {tail}")
        return cp

    def as_dict(self) -> dict:
        return {"job": self.id, "kind": self.kind, "progress": self.progress, "message": self.message,
                "state": self.state, "result": self.result, "error": self.error, "error_code": self.error_code,
                "error_info": self.error_info, "meta": self.meta}


def Path_name(a) -> str:
    return str(a).replace("\\", "/").rsplit("/", 1)[-1]


class JobManager:
    def __init__(self, workers: int = 2):
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="viku-job")
        self.jobs: dict[str, Job] = {}
        self._subs: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self._slock = threading.Lock()

    # ---- SSE -------------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._slock:
            self._subs.append((asyncio.get_running_loop(), q))
        return q

    def unsubscribe(self, q):
        with self._slock:
            self._subs = [s for s in self._subs if s[1] is not q]

    def emit(self, job: Job):
        ev = job.as_dict()
        ev.pop("meta", None)
        data = json.dumps(ev, ensure_ascii=False, default=str)
        with self._slock:
            subs = list(self._subs)
        for loop, q in subs:
            def put(q=q):
                try:
                    q.put_nowait(data)
                except asyncio.QueueFull:
                    pass
            try:
                loop.call_soon_threadsafe(put)
            except RuntimeError:
                self.unsubscribe(q)

    # ---- running ---------------------------------------------------------
    def submit(self, kind: str, fn: Callable[[Job], Any], meta: dict | None = None) -> Job:
        job = Job(self, kind, meta)
        self.jobs[job.id] = job

        def wrapper():
            job.state = "running"
            job.update(0.0, "started")
            try:
                job.result = fn(job)
                job._span = job._outer = (0.0, 1.0)
                job.state = "done"
                job.update(1.0, "done")
            except Cancelled:
                job.state = "error"
                job.error = job.error_code = "cancelled"
                job.update(None, "cancelled")
            except JobError as e:
                job.state = "error"
                job.error = str(e)
                job.error_code, job.error_info = e.code, e.info
                job.update(None, f"error: {e}")
            except Exception as e:  # noqa: BLE001
                job.state = "error"
                job.error = f"{type(e).__name__}: {e}"
                traceback.print_exc()
                job.update(None, f"error: {job.error}")

        self.pool.submit(wrapper)
        self.emit(job)
        return job


MANAGER = JobManager()
