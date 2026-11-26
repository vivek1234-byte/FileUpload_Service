from app import create_app
from conftest import register, upload


# ------------------------------------------------------------------ status + frontend
def test_health_reports_pod_and_volume(client):
    body = client.get("/health").get_json()
    assert body == {"status": "ok", "pod": "test-pod", "storage": "local", "volume": "pvc",
                    "quota": 5120 * 1024 * 1024}


def test_serves_frontend(client):
    res = client.get("/")
    assert res.status_code == 200
    assert b"VORTEX" in res.data
    assert client.get("/app.js").status_code == 200
    assert res.headers["X-Content-Type-Options"] == "nosniff"


# ------------------------------------------------------------------ accounts
def test_register_login_me(client):
    headers = register(client, "Alice_1")
    assert client.get("/auth/me", headers=headers).get_json() == {"username": "Alice_1"}

    res = client.post("/auth/login", json={"username": "alice_1", "password": "secret123"})
    assert res.status_code == 200
    assert res.get_json()["username"] == "Alice_1"  # name keeps its original capitals


def test_duplicate_name_is_rejected_case_insensitively(client):
    register(client, "alice")
    res = client.post("/auth/register", json={"username": "ALICE", "password": "another1"})
    assert res.status_code == 409
    assert "taken" in res.get_json()["error"]


def test_wrong_password_and_unknown_user_give_same_error(client):
    register(client, "alice")
    wrong = client.post("/auth/login", json={"username": "alice", "password": "nope-nope"})
    unknown = client.post("/auth/login", json={"username": "bob", "password": "nope-nope"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.get_json() == unknown.get_json()


def test_register_validation(client):
    bad_name = client.post("/auth/register", json={"username": "a!", "password": "secret123"})
    short_pw = client.post("/auth/register", json={"username": "alice", "password": "123"})
    no_body = client.post("/auth/register", data="not json")
    assert bad_name.status_code == short_pw.status_code == no_body.status_code == 400


def test_passwords_are_not_stored_in_plain_text(app, client):
    register(client, "alice", "secret123")
    users = app.extensions["vortex_storage"].read_users()
    assert "secret123" not in str(users)
    assert users["alice"]["hash"].startswith(("scrypt:", "pbkdf2:"))


def test_requests_without_valid_token_are_rejected(client):
    assert client.get("/files").status_code == 401
    assert client.get("/files", headers={"Authorization": "Bearer forged.token"}).status_code == 401


def test_token_from_another_secret_is_rejected(tmp_path, client):
    other = create_app({"DATA_DIR": str(tmp_path / "other"), "SECRET_KEY": "different"}).test_client()
    foreign = register(other, "alice")
    register(client, "alice")
    assert client.get("/files", headers=foreign).status_code == 401


def test_token_stops_working_when_account_disappears(app, client):
    """What a pod wipe on emptyDir does: the accounts file is gone, so sessions end."""
    headers = register(client)
    app.extensions["vortex_storage"].update_users(lambda users: users.clear())
    res = client.get("/files", headers=headers)
    assert res.status_code == 401
    assert "not found" in res.get_json()["error"]


# ------------------------------------------------------------------ files
def test_upload_list_download_delete(client):
    headers = register(client)
    res = upload(client, headers, "report.pdf", b"%PDF-1.7 data")
    assert res.status_code == 201
    assert res.get_json() == {"uploaded": "report.pdf", "size": 13}

    assert client.get("/files", headers=headers).get_json() == [{"name": "report.pdf", "size": 13}]

    dl = client.get("/download/report.pdf", headers=headers)
    assert dl.status_code == 200
    assert dl.data == b"%PDF-1.7 data"
    assert "attachment" in dl.headers["Content-Disposition"]

    assert client.delete("/files/report.pdf", headers=headers).status_code == 204
    assert client.get("/files", headers=headers).get_json() == []
    assert client.delete("/files/report.pdf", headers=headers).status_code == 404


def test_upload_overwrites_same_name(client):
    headers = register(client)
    upload(client, headers, "a.txt", b"one")
    upload(client, headers, "a.txt", b"three")
    assert client.get("/files", headers=headers).get_json() == [{"name": "a.txt", "size": 5}]


def test_users_cannot_see_each_others_files(client):
    alice = register(client, "alice")
    bob = register(client, "bob")
    upload(client, alice, "diary.txt", b"private")

    assert client.get("/files", headers=bob).get_json() == []
    assert client.get("/download/diary.txt", headers=bob).status_code == 404
    assert client.delete("/files/diary.txt", headers=bob).status_code == 404
    assert client.get("/download/diary.txt", headers=alice).data == b"private"


def test_path_tricks_stay_inside_the_users_folder(app, client, tmp_path):
    headers = register(client)
    res = upload(client, headers, "../../etc/passwd", b"x")
    assert res.status_code == 201
    assert res.get_json()["uploaded"] == "etc_passwd"
    assert (tmp_path / "data" / "files" / "alice" / "etc_passwd").exists()
    assert client.get("/download/..%2F..%2Fusers.json", headers=headers).status_code == 404


def test_upload_errors(client):
    headers = register(client)
    assert client.post("/upload", headers=headers, data={}).status_code == 400
    assert upload(client, headers, "...", b"x").status_code == 400
    too_big = upload(client, headers, "big.bin", b"0" * (3 * 1024 * 1024))
    assert too_big.status_code == 413
    assert "too large" in too_big.get_json()["error"]


def test_secret_key_is_kept_on_disk_when_not_configured(tmp_path):
    first = create_app({"DATA_DIR": str(tmp_path), "SECRET_KEY": None})
    second = create_app({"DATA_DIR": str(tmp_path), "SECRET_KEY": None})
    assert first.config["SECRET_KEY"] == second.config["SECRET_KEY"]


# ------------------------------------------------------------------ per-user storage quota
def test_quota_blocks_uploads_past_the_limit(tmp_path):
    client = create_app({"DATA_DIR": str(tmp_path), "SECRET_KEY": "k", "USER_QUOTA_MB": 2}).test_client()
    alice = register(client, "alice")
    chunk = b"0" * (900 * 1024)  # 0.9 MB, under the 200 MB per-file limit

    assert upload(client, alice, "a.bin", chunk).status_code == 201
    assert upload(client, alice, "b.bin", chunk).status_code == 201
    full = upload(client, alice, "c.bin", chunk)  # would make 2.7 MB of 2 MB
    assert full.status_code == 413
    assert "Storage full" in full.get_json()["error"]
    assert [f["name"] for f in client.get("/files", headers=alice).get_json()] == ["a.bin", "b.bin"]

    # Replacing a file only counts its new size
    assert upload(client, alice, "b.bin", chunk).status_code == 201
    # Deleting frees space again
    client.delete("/files/a.bin", headers=alice)
    assert upload(client, alice, "c.bin", chunk).status_code == 201


def test_quota_is_per_user(tmp_path):
    client = create_app({"DATA_DIR": str(tmp_path), "SECRET_KEY": "k", "USER_QUOTA_MB": 1}).test_client()
    alice, bob = register(client, "alice"), register(client, "bob")
    chunk = b"0" * (900 * 1024)
    assert upload(client, alice, "a.bin", chunk).status_code == 201
    assert upload(client, bob, "b.bin", chunk).status_code == 201  # Alice's files don't use Bob's space
