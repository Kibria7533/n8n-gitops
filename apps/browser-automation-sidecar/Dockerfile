FROM mcr.microsoft.com/playwright:v1.48.0-jammy

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-hosny-amiri \
      fonts-noto-core \
      fonts-beng \
      fonts-lohit-beng-bengali \
      python3-pip \
    && pip3 install --no-cache-dir edge-tts \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY music/ ./music/
COPY music-desi/ ./music-desi/
COPY server.js ./

CMD ["node", "server.js"]
