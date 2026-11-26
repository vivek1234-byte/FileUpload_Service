"""HTTP API used by the frontend (see frontend/js/api.js for the same contract)."""
from __future__ import annotations

import re
import threading
import time
from functools import wraps

from flask import Blueprint, Response, current_app, g, jsonify, request, send_file, stream_with_context
from itsdangerous import BadSignature, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

bp = Blueprint("api", __name__)

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,20}$")
MIN_PASSWORD, MAX_PASSWORD = 6, 200
MAX_FILENAME = 200
# Compared against when a name doesn't exist, so a wrong name takes as long as a wrong password.
_DUMMY_HASH = generate_password_hash("no-such-user-placeholder")
MB = 1024 * 1024

# One lock per user, so two uploads from the same user can't both squeeze under the quota.
_user_locks: dict[str, threading.Lock] = {}
_user_locks_guard = threading.Lock()


def _user_lock(user: str) -> threading.Lock:
    with _user_locks_guard:
        return _user_locks.setdefault(user, threading.Lock())


def quota_bytes() -> int:
    return current_app.config["USER_QUOTA_MB"] * MB


def format_size(n: int) -> str:
    return f"{n / (1024 * MB):.2f} GB" if n >= 1024 * MB else f"{n / MB:.1f} MB"


def error(message: str, status: int):
    return jsonify(error=message), status


def storage():
    return current_app.extensions["vortex_storage"]


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt="vortex-auth")


def _token_for(key: str, created: int) -> str:
    # "c" ties the token to this exact account: if the account is deleted and someone
    # registers the same name again, old tokens don't open the new account.
    return _serializer().dumps({"u": key, "c": created})


def clean_filename(name: str | None) -> str | None:
    cleaned = secure_filename(name or "")
    if not cleaned or len(cleaned) > MAX_FILENAME:
        return None
    return cleaned


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return error("Sign in required", 401)
        try:
            data = _serializer().loads(header[7:], max_age=current_app.config["TOKEN_MAX_AGE"])
        except BadSignature:  # also covers expired tokens
            return error("Session expired, please sign in again", 401)
        key = data.get("u") if isinstance(data, dict) else None
        account = storage().read_users().get(key) if key else None
        if not account or data.get("c") != account.get("created"):
            # e.g. the accounts lived on an emptyDir volume that was wiped with the pod,
            # or the account was deleted (and maybe registered again by someone else)
            return error("Account not found on this server", 401)
        g.user = key
        g.display = account["display"]
        return view(*args, **kwargs)

    return wrapper


def _credentials():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    return username, password


# ------------------------------------------------------------------ status
@bp.get("/health")
def health():
    cfg = current_app.config
    return jsonify(status="ok", pod=cfg["POD_NAME"], storage=cfg["STORAGE"], volume=cfg["STORAGE_VOLUME"],
                   quota=quota_bytes())


# ------------------------------------------------------------------ accounts
@bp.post("/auth/register")
def register():
    username, password = _credentials()
    if not NAME_RE.fullmatch(username):
        return error("Username must be 3-20 letters, numbers, _ or -", 400)
    if not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
        return error(f"Password must be {MIN_PASSWORD}-{MAX_PASSWORD} characters", 400)

    key = username.lower()
    record = {"display": username, "hash": generate_password_hash(password), "created": int(time.time())}

    def add(users: dict) -> bool:
        if key in users:
            return False
        users[key] = record
        return True

    if not storage().update_users(add):
        return error("That username is already taken", 409)
    return jsonify(username=username, token=_token_for(key, record["created"])), 201


@bp.post("/auth/login")
def login():
    username, password = _credentials()
    if not username or not password:
        return error("Enter your username and password", 400)
    account = storage().read_users().get(username.lower())
    if not account:
        check_password_hash(_DUMMY_HASH, password)
        return error("Wrong username or password", 401)
    if not check_password_hash(account["hash"], password):
        return error("Wrong username or password", 401)
    return jsonify(username=account["display"], token=_token_for(username.lower(), account["created"]))


@bp.get("/auth/me")
@login_required
def me():
    return jsonify(username=g.display)


@bp.delete("/auth/me")
@login_required
def delete_account():
    """Deletes the signed-in user's files and account. The password must be sent again."""
    password = str((request.get_json(silent=True) or {}).get("password", ""))
    account = storage().read_users().get(g.user)
    if not account or not check_password_hash(account["hash"], password):
        return error("Wrong password", 403)  # 403, not 401: the session itself is still fine

    with _user_lock(g.user):
        files = storage().delete_all(g.user)  # files first: if this fails, the account is kept and can retry
        storage().update_users(lambda users: users.pop(g.user, None))
    return jsonify(deleted=g.display, files=files)


# ------------------------------------------------------------------ files (always the signed-in user's)
@bp.get("/files")
@login_required
def list_files():
    return jsonify(storage().list(g.user))


@bp.post("/upload")
@login_required
def upload():
    upload_file = request.files.get("file")
    if upload_file is None:
        return error("No file in the request (form field must be called 'file')", 400)
    name = clean_filename(upload_file.filename)
    if not name:
        return error("That file name is not allowed", 400)

    stream = upload_file.stream
    stream.seek(0, 2)  # the upload is already spooled, so its exact size is known
    incoming = stream.tell()
    stream.seek(0)

    limit = quota_bytes()
    with _user_lock(g.user):
        # Replacing a file frees its old size, so it doesn't count twice.
        used = sum(f["size"] for f in storage().list(g.user) if f["name"] != name)
        if used + incoming > limit:
            free = max(limit - used, 0)
            return error(f"Storage full: you can store {format_size(limit)}, "
                         f"{format_size(free)} is left and this file is {format_size(incoming)}", 413)
        size = storage().save(g.user, name, stream)
    return jsonify(uploaded=name, size=size), 201


@bp.get("/download/<path:name>")
@login_required
def download(name: str):
    name = clean_filename(name)
    if not name:
        return error("File not found", 404)
    store = storage()

    if hasattr(store, "path"):  # local disk
        path = store.path(g.user, name)
        if not path:
            return error("File not found", 404)
        return send_file(path, as_attachment=True, download_name=name, mimetype="application/octet-stream")

    opened = store.open(g.user, name)  # MinIO
    if not opened:
        return error("File not found", 404)
    obj, size = opened

    def stream():
        try:
            yield from obj.stream(64 * 1024)
        finally:
            obj.close()
            obj.release_conn()

    return Response(stream_with_context(stream()), mimetype="application/octet-stream", headers={
        "Content-Length": str(size),
        "Content-Disposition": f'attachment; filename="{name}"',
    })


@bp.delete("/files/<path:name>")
@login_required
def delete_file(name: str):
    name = clean_filename(name)
    if not name or not storage().delete(g.user, name):
        return error("File not found", 404)
    return "", 204
