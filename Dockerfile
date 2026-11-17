# Container recipe used when MoSite runs as a Home Assistant add-on.
# (Not needed for running it on Windows - Start Budget Site.bat does that.)
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MOSITE_DATA_DIR=/config \
    TZ=America/Chicago

WORKDIR /app

# Packages first, so rebuilding after a code change doesn't reinstall them.
COPY requirements-stocks.txt requirements-statement-import.txt ./
RUN pip install --no-cache-dir tzdata -r requirements-stocks.txt -r requirements-statement-import.txt

COPY . /app

CMD ["python", "/app/ha_start.py"]
