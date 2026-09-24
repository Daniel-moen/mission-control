# Build the React panel and run the relay in one image.
# We use a Dockerfile (rather than Railway's auto-builder) for a deterministic
# Node version and a reliable cross-platform install.

# ---- whisper.cpp for talk mode (stt.js) --------------------------------------
# Built from source (static, no OpenMP runtime dep) and shipped with two English
# models; WHISPER_MODEL picks one. GGML_NATIVE=OFF because the build machine's
# CPU isn't necessarily the one we run on — AVX2/FMA are on every x86 host
# Railway uses.
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp /w
WORKDIR /w
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
      $( [ "$(uname -m)" = "x86_64" ] && echo "-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON" ) \
 && cmake --build build -j --config Release --target whisper-cli
RUN mkdir /models \
 && curl -fsSL -o /models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
 && curl -fsSL -o /models/ggml-small.en-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin

# ---- the relay + panel -------------------------------------------------------
FROM node:20-slim
WORKDIR /app

COPY --from=whisper /w/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models /models
ENV WHISPER_MODEL=/models/ggml-base.en.bin

# Install dependencies, including the dev tooling needed to build the panel.
# `npm install` (not `npm ci`) so the Linux-native optional deps for Tailwind's
# oxide engine and Rollup resolve correctly here — npm's cross-platform
# optional-dependency bug otherwise drops them from a lockfile generated on
# another OS ("Cannot find native binding").
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# Build the SPA into dist/.
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
