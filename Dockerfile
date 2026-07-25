FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    CONFIG_PATH=/app/config/settings.yaml

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt pyproject.toml README.md ./
COPY src ./src
COPY config ./config

RUN pip install --upgrade pip && pip install .

RUN useradd --create-home --shell /bin/bash appuser \
    && mkdir -p /app/logs /app/data \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

CMD ["mexc-assistant"]
