# syntax=docker/dockerfile:1.7
# Build from this directory: docker build -f workers/ifc/Dockerfile workers/ifc
#
# A separate process and image because IfcOpenShell is LGPL (FLR architecture): the Node worker
# talks to it over HTTP on the compose network (IFC_WORKER_URL, default http://ifc-worker:3410);
# no host port is published. Dependencies come from requirements.lock with every file's sha256
# checked, wheels only — nothing is compiled and no build backend is fetched: the package is not
# installed, it runs from /app.

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    IFC_WORKER_HOST=0.0.0.0 IFC_WORKER_PORT=3410
WORKDIR /app
COPY requirements.lock ./
RUN pip install --require-hashes --only-binary=:all: -r requirements.lock \
 && useradd --system --uid 10001 --no-create-home ifc
COPY floorspec_ifc ./floorspec_ifc
USER ifc
EXPOSE 3410
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-m", "floorspec_ifc", "health"]
CMD ["python", "-m", "floorspec_ifc", "serve"]
