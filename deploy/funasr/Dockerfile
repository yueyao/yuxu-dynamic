FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/huggingface \
    MODELSCOPE_CACHE=/models/modelscope \
    XDG_CACHE_HOME=/models/cache

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 funasr \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin funasr \
    && mkdir -p /models/huggingface /models/modelscope /models/cache \
    && chown -R 10001:10001 /models /home/funasr

COPY deploy/funasr/requirements-cpu.txt /tmp/requirements-cpu.txt
RUN python -m pip install --index-url https://download.pytorch.org/whl/cpu \
      torch==2.11.0 torchaudio==2.11.0 \
    && python -m pip install --requirement /tmp/requirements-cpu.txt \
    && python -m pip check \
    && rm /tmp/requirements-cpu.txt

USER 10001:10001
WORKDIR /home/funasr
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).read()"]

ENTRYPOINT ["funasr-server"]
CMD ["--host", "0.0.0.0", "--port", "8000", "--device", "cpu", "--model", "sensevoice"]
