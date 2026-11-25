import io

import pytest

from app import create_app


@pytest.fixture
def app(tmp_path):
    return create_app({
        "DATA_DIR": str(tmp_path / "data"),
        "SECRET_KEY": "test-secret",
        "STORAGE_VOLUME": "pvc",
        "POD_NAME": "test-pod",
        "MAX_UPLOAD_MB": 1,
    })


@pytest.fixture
def client(app):
    return app.test_client()


def register(client, username="alice", password="secret123"):
    res = client.post("/auth/register", json={"username": username, "password": password})
    assert res.status_code == 201, res.get_json()
    return {"Authorization": f"Bearer {res.get_json()['token']}"}


def upload(client, headers, name="notes.txt", data=b"hello"):
    return client.post("/upload", headers=headers, data={"file": (io.BytesIO(data), name)},
                       content_type="multipart/form-data")
