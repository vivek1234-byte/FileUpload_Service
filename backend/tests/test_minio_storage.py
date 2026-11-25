"""MinioStorage tested against a small in-memory stand-in for the MinIO client."""
import io
from types import SimpleNamespace

from minio.error import S3Error

from app.storage import MinioStorage


class FakeResponse(io.BytesIO):
    def stream(self, size):
        while chunk := self.read(size):
            yield chunk

    def release_conn(self):
        pass


class FakeMinio:
    def __init__(self):
        self.buckets, self.objects = set(), {}

    def _missing(self, key):
        return S3Error(SimpleNamespace(status=404, headers={}), "NoSuchKey", "missing", key, "r", "h")

    def bucket_exists(self, bucket):
        return bucket in self.buckets

    def make_bucket(self, bucket):
        self.buckets.add(bucket)

    def put_object(self, bucket, key, data, length, **_kw):
        self.objects[key] = data.read()

    def stat_object(self, bucket, key):
        if key not in self.objects:
            raise self._missing(key)
        return SimpleNamespace(size=len(self.objects[key]))

    def get_object(self, bucket, key):
        if key not in self.objects:
            raise self._missing(key)
        return FakeResponse(self.objects[key])

    def list_objects(self, bucket, prefix=""):
        return [SimpleNamespace(object_name=k, size=len(v)) for k, v in self.objects.items() if k.startswith(prefix)]

    def remove_object(self, bucket, key):
        del self.objects[key]


def test_minio_storage_round_trip():
    fake = FakeMinio()
    store = MinioStorage(fake, "uploads")
    assert "uploads" in fake.buckets

    assert store.save("alice", "a.txt", io.BytesIO(b"hello")) == 5
    store.save("bob", "b.txt", io.BytesIO(b"x"))
    assert store.list("alice") == [{"name": "a.txt", "size": 5}]
    assert "files/alice/a.txt" in fake.objects

    obj, size = store.open("alice", "a.txt")
    assert size == 5 and b"".join(obj.stream(2)) == b"hello"
    assert store.open("bob", "a.txt") is None

    assert store.delete("alice", "a.txt") is True
    assert store.delete("alice", "a.txt") is False


def test_minio_accounts_live_in_the_bucket():
    fake = FakeMinio()
    store = MinioStorage(fake, "uploads")
    assert store.read_users() == {}
    store.update_users(lambda users: users.update(alice={"display": "Alice"}))
    assert MinioStorage(fake, "uploads").read_users() == {"alice": {"display": "Alice"}}
