# BTQ Core node for the devnet (regtest). Binaries come from the official v0.5.0-testnet
# release (deploy/btqd/fetch-binaries.sh copies them into ./bin and checks the SHA-256).
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd -r -m -d /home/btq -s /usr/sbin/nologin btq && mkdir -p /data && chown btq:btq /data
COPY bin/btqd bin/btq-cli /usr/local/bin/
USER btq
VOLUME ["/data"]
EXPOSE 18443
ENTRYPOINT ["btqd", "-datadir=/data", "-printtoconsole"]
