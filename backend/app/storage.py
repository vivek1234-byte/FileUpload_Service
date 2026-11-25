"""Where files and accounts are kept.

Two backends with the same methods:
  LocalStorage  - a folder on disk (an emptyDir or a PersistentVolumeClaim in Kubernetes)
  MinioStorage  - an S3-compatible MinIO bucket

Each user's files live under their own prefix, so users never see each other's files.
The account list (users.json) is stored next to the files on purpose: on an emptyDir
volume, deleting the pod loses the accounts too, which is exactly the lesson of the demo.
"""
from __future__ import annotations

import fcntl
import json
import os
import tempfile
import threading
from contextlib import contextmanager
from typing import BinaryIO, Callable, Iterator


class LocalStorage:
    def __init__(self, root: str):
        self.root = root
        self.files_root = os.path.join(root, "files")
        self.users_path = os.path.join(root, "users.json")
        self._lock_path = os.path.join(root, ".users.lock")
        self._thread_lock = threading.Lock()
        os.makedirs(self.files_root, exist_ok=True)

    # ------------------------------------------------------------ files
    def _user_dir(self, user: str) -> str:
        return os.path.join(self.files_root, user)

    def list(self, user: str) -> list[dict]:
        folder = self._user_dir(user)
        if not os.path.isdir(folder):
            return []
        files = []
        for entry in os.scandir(folder):
            if entry.is_file() and not entry.name.startswith(".upload-"):
                files.append({"name": entry.name, "size": entry.stat().st_size})
        return sorted(files, key=lambda f: f["name"])

    def save(self, user: str, name: str, stream: BinaryIO) -> int:
        folder = self._user_dir(user)
        os.makedirs(folder, exist_ok=True)
        # Write to a temp file first, then rename, so a half-written upload never shows up.
        fd, tmp = tempfile.mkstemp(prefix=".upload-", dir=folder)
        try:
            with os.fdopen(fd, "wb") as out:
                while chunk := stream.read(1024 * 1024):
                    out.write(chunk)
            os.replace(tmp, os.path.join(folder, name))
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        return os.path.getsize(os.path.join(folder, name))

    def path(self, user: str, name: str) -> str | None:
        p = os.path.join(self._user_dir(user), name)
        return p if os.path.isfile(p) else None

    def delete(self, user: str, name: str) -> bool:
        p = self.path(user, name)
        if not p:
            return False
        os.unlink(p)
        return True

    # ------------------------------------------------------------ accounts
    @contextmanager
    def _users_lock(self) -> Iterator[None]:
        # Thread lock for gunicorn threads, file lock in case several worker processes share the disk.
        with self._thread_lock, open(self._lock_path, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _read_users(self) -> dict:
        try:
            with open(self.users_path, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {}

    def read_users(self) -> dict:
        return self._read_users()

    def update_users(self, change: Callable[[dict], object]) -> object:
        """Read the account list, let `change` edit it, write it back atomically."""
        with self._users_lock():
            users = self._read_users()
            result = change(users)
            fd, tmp = tempfile.mkstemp(prefix=".users-", dir=self.root)
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(users, out)
            os.replace(tmp, self.users_path)
            return result


class MinioStorage:
    USERS_KEY = "_system/users.json"

    def __init__(self, client, bucket: str):
        self.client = client
        self.bucket = bucket
        self._lock = threading.Lock()
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)

    @staticmethod
    def _prefix(user: str) -> str:
        return f"files/{user}/"

    def _missing(self, err) -> bool:
        return getattr(err, "code", None) in ("NoSuchKey", "NoSuchObject", "ResourceNotFound")

    # ------------------------------------------------------------ files
    def list(self, user: str) -> list[dict]:
        prefix = self._prefix(user)
        objects = self.client.list_objects(self.bucket, prefix=prefix)
        files = [{"name": o.object_name[len(prefix):], "size": o.size} for o in objects]
        return sorted(files, key=lambda f: f["name"])

    def save(self, user: str, name: str, stream: BinaryIO) -> int:
        key = self._prefix(user) + name
        self.client.put_object(self.bucket, key, stream, length=-1, part_size=10 * 1024 * 1024)
        return self.client.stat_object(self.bucket, key).size

    def open(self, user: str, name: str):
        """Returns (response, size) or None. The caller must close the response."""
        from minio.error import S3Error

        key = self._prefix(user) + name
        try:
            size = self.client.stat_object(self.bucket, key).size
        except S3Error as err:
            if self._missing(err):
                return None
            raise
        return self.client.get_object(self.bucket, key), size

    def delete(self, user: str, name: str) -> bool:
        from minio.error import S3Error

        key = self._prefix(user) + name
        try:
            self.client.stat_object(self.bucket, key)
        except S3Error as err:
            if self._missing(err):
                return False
            raise
        self.client.remove_object(self.bucket, key)
        return True

    # ------------------------------------------------------------ accounts
    def read_users(self) -> dict:
        from minio.error import S3Error

        try:
            resp = self.client.get_object(self.bucket, self.USERS_KEY)
        except S3Error as err:
            if self._missing(err):
                return {}
            raise
        try:
            return json.loads(resp.read())
        finally:
            resp.close()
            resp.release_conn()

    def update_users(self, change: Callable[[dict], object]) -> object:
        # Safe within one process. With several app replicas, two sign-ups at the same
        # instant could race; a real database would fix that.
        import io

        with self._lock:
            users = self.read_users()
            result = change(users)
            data = json.dumps(users).encode()
            self.client.put_object(self.bucket, self.USERS_KEY, io.BytesIO(data), len(data),
                                   content_type="application/json")
            return result


def storage_from_config(config: dict):
    if config["STORAGE"] == "minio":
        from minio import Minio

        client = Minio(
            config["MINIO_ENDPOINT"],
            access_key=config["MINIO_ACCESS_KEY"],
            secret_key=config["MINIO_SECRET_KEY"],
            secure=config["MINIO_SECURE"],
        )
        return MinioStorage(client, config["MINIO_BUCKET"])
    return LocalStorage(config["DATA_DIR"])
