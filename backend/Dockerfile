FROM python:3.12-slim AS runtime

WORKDIR /app

# Install python requirements (pre-compiled wheels, no build dependencies needed)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Bind to $PORT when provided (Render/Railway inject it), else 8000 for local.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
