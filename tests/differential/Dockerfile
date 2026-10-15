# A throwaway machine for the differential test: commands really run here, as the
# unprivileged user `node`, with no network. See scripts/differential.mjs.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends strace python3 perl git procps \
  && rm -rf /var/lib/apt/lists/*
