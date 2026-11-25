"""VORTEX File Upload Service - Flask backend.

Settings come from environment variables (see README.md):
  STORAGE           local | minio                      (default local)
  DATA_DIR          folder for local storage           (default /data)
  STORAGE_VOLUME    emptyDir | pvc - shown in the game so players see what kind of disk this is
  SECRET_KEY        signs login tokens; set it from a Kubernetes Secret in production
  MAX_UPLOAD_MB     largest accepted upload            (default 200)
  USER_QUOTA_MB     most a single user may store       (default 5120 = 5 GB)
  TOKEN_MAX_AGE     seconds a login stays valid        (default 7 days)
  MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET, MINIO_SECURE
  FRONTEND_DIR      folder with the 3D frontend        (default ../frontend)
"""
from __future__ import annotations

import logging
import os
import secrets
import socket

from flask import Flask, jsonify, send_from_directory

from .storage import storage_from_config

log = logging.getLogger("vortex")
HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(overrides: dict | None = None) -> dict:
    env = os.environ
    cfg = {
        "STORAGE": env.get("STORAGE", "local").strip().lower(),
        "DATA_DIR": env.get("DATA_DIR", "/data"),
        "STORAGE_VOLUME": env.get("STORAGE_VOLUME") or None,
        "SECRET_KEY": env.get("SECRET_KEY") or None,
        "MAX_UPLOAD_MB": int(env.get("MAX_UPLOAD_MB", "200")),
        "USER_QUOTA_MB": int(env.get("USER_QUOTA_MB", "5120")),
        "TOKEN_MAX_AGE": int(env.get("TOKEN_MAX_AGE", str(7 * 24 * 3600))),
        "MINIO_ENDPOINT": env.get("MINIO_ENDPOINT", "minio:9000"),
        "MINIO_ACCESS_KEY": env.get("MINIO_ACCESS_KEY", ""),
        "MINIO_SECRET_KEY": env.get("MINIO_SECRET_KEY", ""),
        "MINIO_BUCKET": env.get("MINIO_BUCKET", "uploads"),
        "MINIO_SECURE": env.get("MINIO_SECURE", "false").lower() == "true",
        "FRONTEND_DIR": env.get("FRONTEND_DIR", os.path.normpath(os.path.join(HERE, "..", "..", "frontend"))),
        "POD_NAME": env.get("POD_NAME") or socket.gethostname(),
    }
    cfg.update(overrides or {})
    if cfg["STORAGE"] not in ("local", "minio"):
        raise ValueError(f"STORAGE must be 'local' or 'minio', not {cfg['STORAGE']!r}")
    return cfg


def _secret_key(cfg: dict) -> str:
    if cfg["SECRET_KEY"]:
        return cfg["SECRET_KEY"]
    if cfg["STORAGE"] == "local":
        # Keep a generated key next to the data, so logins survive a restart (on a PVC).
        os.makedirs(cfg["DATA_DIR"], exist_ok=True)
        path = os.path.join(cfg["DATA_DIR"], ".secret_key")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_hex(32))
        except FileExistsError:
            pass
        with open(path) as f:
            return f.read().strip()
    log.warning("SECRET_KEY is not set: using a random key, so everyone is signed out on restart")
    return secrets.token_hex(32)


def create_app(overrides: dict | None = None) -> Flask:
    cfg = load_config(overrides)
    frontend = cfg["FRONTEND_DIR"] if os.path.isdir(cfg["FRONTEND_DIR"]) else None

    app = Flask(__name__, static_folder=frontend, static_url_path="")
    app.config.update(cfg)
    app.config["SECRET_KEY"] = _secret_key(cfg)
    app.config["MAX_CONTENT_LENGTH"] = (cfg["MAX_UPLOAD_MB"] + 1) * 1024 * 1024  # +1 MB for form overhead
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # browsers re-check the frontend files, so updates show up
    app.extensions["vortex_storage"] = storage_from_config(cfg)

    from .api import bp

    app.register_blueprint(bp)

    @app.get("/")
    def index():
        if not frontend:
            return jsonify(service="vortex-file-upload", frontend="not bundled"), 200
        return send_from_directory(frontend, "index.html")

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        return resp

    @app.errorhandler(413)
    def too_large(_err):
        return jsonify(error=f"File is too large (limit {cfg['MAX_UPLOAD_MB']} MB)"), 413

    @app.errorhandler(500)
    def server_error(err):
        log.exception("unhandled error: %s", err)
        return jsonify(error="Server error"), 500

    log.info("storage=%s volume=%s pod=%s", cfg["STORAGE"], cfg["STORAGE_VOLUME"], cfg["POD_NAME"])
    return app
