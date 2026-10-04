# syntax=docker/dockerfile:1.7
# Build from this directory: docker build -f workers/ifc/Dockerfile workers/ifc
# A separate process and image because IfcOpenShell is LGPL (FLR architecture). Phase 0 installs
# no IfcOpenShell; the worker only proves it runs and answers its health check.

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY pyproject.toml ./
COPY floorspec_ifc ./floorspec_ifc
RUN pip install . && useradd --system --uid 10001 --no-create-home ifc
USER ifc
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-m", "floorspec_ifc", "health"]
CMD ["python", "-m", "floorspec_ifc"]
