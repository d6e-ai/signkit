FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements-linux-amd64.lock .
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements-linux-amd64.lock
COPY seal_engine.py .
RUN useradd --system --no-create-home --uid 10001 engine
USER 10001
EXPOSE 8080
CMD ["python", "-I", "seal_engine.py"]
