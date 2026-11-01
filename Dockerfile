# ---- build: wheels for the app and its dependencies ----
FROM python:3.15-slim AS build
WORKDIR /src
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
COPY web ./web
RUN pip wheel --wheel-dir /wheels ".[api]"

# ---- runtime: Python + Java (Tika Server) + Tesseract (OCR), non-root ----
FROM python:3.15-slim
ARG TIKA_VERSION=3.3.2
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    PTE_TIKA_JAR=/opt/tika/tika-server.jar \
    PTE_TIKA_JAVA_OPTS="-Xshare:auto -XX:+UseParallelGC -XX:MaxRAMPercentage=50"
COPY --from=build /wheels /wheels
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      default-jre-headless tesseract-ocr tesseract-ocr-por tesseract-ocr-eng curl ca-certificates \
 && mkdir -p /opt/tika \
 && curl -fsSL -o /opt/tika/tika-server.jar \
      "https://repo1.maven.org/maven2/org/apache/tika/tika-server-standard/${TIKA_VERSION}/tika-server-standard-${TIKA_VERSION}.jar" \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && pip install --no-index --find-links=/wheels "papero-extract[api]" \
 && rm -rf /wheels \
 && useradd --create-home --uid 10001 app
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health', timeout=2)"
# One uvicorn process (async I/O + Tika calls) + PTE_WORKERS layout processes (CPU).
# Tika Server is started and warmed up by the app itself on startup.
CMD ["sh", "-c", "exec uvicorn papero_extract.api:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 30"]
