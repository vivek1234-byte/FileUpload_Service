# VORTEX File Upload Service: Flask API + web page in one image.

# ---- Stage "test": only built when asked for (docker build --target test .), the build
# fails if a test fails. Jenkins uses this, so its server needs nothing but Docker.
FROM python:3.12-slim AS test
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /app/backend
COPY backend/requirements.txt backend/requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY backend ./
COPY frontend /app/frontend
RUN python -m pytest -q -p no:cacheprovider

# ---- Final image (the default target). Tests and pytest are not in it.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/frontend

WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY backend/wsgi.py .
COPY frontend /app/frontend

# Run as a normal user. /data is where Kubernetes mounts the emptyDir or PVC.
RUN useradd --uid 10001 --create-home vortex && mkdir -p /data && chown vortex:vortex /data
USER 10001
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"

# One worker process with threads: the in-process locks then cover every request.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "8", "--timeout", "300", "--access-logfile", "-", "wsgi:app"]
