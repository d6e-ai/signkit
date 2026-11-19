FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY config.py engine.py server.py ./
RUN useradd --system --no-create-home --uid 10001 validator
USER 10001

EXPOSE 8080
# Configuration (all required): VALIDATOR_TOKEN, SEAL_CA_DER (base64 DER), SEAL_CERTIFICATE_SHA256,
# SEAL_POLICY_ID, VALIDATION_POLICY_ID. Optional: VALIDATOR_MAX_SEALED_BYTES (<= 64 MiB).
HEALTHCHECK --interval=30s --timeout=3s CMD ["python", "-c", "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"]
CMD ["python", "server.py"]
