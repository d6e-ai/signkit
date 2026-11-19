FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY seal_engine.py .
RUN useradd --system --no-create-home --uid 10001 engine
USER 10001
EXPOSE 8080
CMD ["python", "-I", "seal_engine.py"]
