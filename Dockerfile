# One Railway service, two programs: the scraper (Node 20) and the username claimer (Python 3.12).
# Python 3.12 is the base (aiogram 3.x breaks on 3.11); Node is copied in from the official image.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && node --version && npm --version
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY claimer/requirements.txt claimer/requirements.txt
RUN python -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir -r claimer/requirements.txt \
 && /opt/py/bin/python --version
COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["sh", "start.sh"]
