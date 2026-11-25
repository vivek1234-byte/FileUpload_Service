"""HTTP API used by the frontend (see frontend/js/api.js for the same contract)."""
from __future__ import annotations

import re
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


def error(message: str, status: int):
    return jsonify(error=message), status


def storage():
    return current_app.extensions["vortex_storage"]


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt="vortex-auth")


def _token_for(key: str) -> str:
    return _serializer().dumps({"u": key})


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
        if not account:
            # e.g. the accounts lived on an emptyDir volume that was wiped with the pod
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
    return jsonify(status="ok", pod=cfg["POD_NAME"], storage=cfg["STORAGE"], volume=cfg["STORAGE_VOLUME"])


# ------------------------------------------------------------------ accounts
@bp.post("/auth/register")
def register():
    username, password = _credentials()
    if not NAME_RE.fullmatch(username):
        return error("Player name must be 3-20 letters, numbers, _ or -", 400)
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
        return error("That player name is already taken", 409)
    return jsonify(username=username, token=_token_for(key)), 201


@bp.post("/auth/login")
def login():
    username, password = _credentials()
    if not username or not password:
        return error("Enter your player name and password", 400)
    account = storage().read_users().get(username.lower())
    if not account:
        check_password_hash(_DUMMY_HASH, password)
        return error("Wrong player name or password", 401)
    if not check_password_hash(account["hash"], password):
        return error("Wrong player name or password", 401)
    return jsonify(username=account["display"], token=_token_for(username.lower()))


@bp.get("/auth/me")
@login_required
def me():
    return jsonify(username=g.display)


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
    size = storage().save(g.user, name, upload_file.stream)
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
