# One Railway service, two programs: the scraper (Node) and the username claimer (Python).
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY claimer/requirements.txt claimer/requirements.txt
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir -r claimer/requirements.txt
COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["sh", "start.sh"]
