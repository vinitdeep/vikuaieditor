"""Secrets at rest: Windows DPAPI (CryptProtectData, current-user scope) through ctypes - no pywin32 needed.

`protect(text) -> str` returns base64 of the DPAPI blob; `unprotect(b64) -> str` reverses it. Only the Windows user
who stored a secret can read it back (another account or another PC gets ""). Secrets are never logged.
On non-Windows platforms there is no DPAPI: protect() raises VaultUnavailable and the caller keeps the secret in
memory for the session only (never plaintext on disk).
"""
from __future__ import annotations

import base64
import ctypes
import sys

ENTROPY = b"viku-engine/secret/v1"


class VaultUnavailable(RuntimeError):
    pass


if sys.platform == "win32":
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _crypt32.CryptProtectData.argtypes = [ctypes.POINTER(_Blob), wintypes.LPCWSTR, ctypes.POINTER(_Blob),
                                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    _crypt32.CryptProtectData.restype = wintypes.BOOL
    _crypt32.CryptUnprotectData.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.POINTER(_Blob),
                                            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    _crypt32.CryptUnprotectData.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel32.LocalFree.restype = ctypes.c_void_p
    _UI_FORBIDDEN = 0x1

    def _in(b: bytes) -> tuple[_Blob, ctypes.Array]:
        buf = ctypes.create_string_buffer(b, len(b))
        return _Blob(len(b), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf

    def _call(fn, data: bytes, *mid) -> bytes:
        blob, _keep = _in(data)
        ent, _keep2 = _in(ENTROPY)
        out = _Blob()
        if not fn(ctypes.byref(blob), *mid, ctypes.byref(ent), None, None, _UI_FORBIDDEN, ctypes.byref(out)):
            raise OSError(ctypes.get_last_error(), "DPAPI call failed")
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            _kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))

    def protect(text: str) -> str:
        return base64.b64encode(_call(_crypt32.CryptProtectData, text.encode("utf-8"), "viku")).decode("ascii")

    def unprotect(b64: str) -> str:
        if not b64:
            return ""
        try:
            return _call(_crypt32.CryptUnprotectData, base64.b64decode(b64), None).decode("utf-8")
        except (OSError, ValueError):
            return ""  # another user / another PC / corrupted: behave as "no token"

    def available() -> bool:
        return True
else:  # pragma: no cover - the app ships for Windows
    def protect(text: str) -> str:
        raise VaultUnavailable("no DPAPI on this platform")

    def unprotect(b64: str) -> str:
        return ""

    def available() -> bool:
        return False
